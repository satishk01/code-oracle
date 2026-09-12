/**
 * Agent Engine
 *
 * The core iterative agent loop — TypeScript equivalent of OpenWorker's
 * `TurnEngine` (`coworker/engine.py:440-563`). Turns Q&A from single-shot
 * into an iterative tool-using loop:
 *
 *  1. Send messages + tool schemas to the provider
 *  2. Receive text deltas AND tool calls (streamed)
 *  3. Execute tool calls via the registry (reads concurrent, writes serial)
 *  4. Feed tool results back to the model
 *  5. Loop until the model returns a final answer or hits maxIterations
 *  6. Emit events: TURN_START, ASSISTANT_DELTA, TOOL_PROPOSED,
 *     TOOL_FINISHED, TURN_END, ERROR, MAX_ITERATIONS
 *
 * If the provider does not support tool-calling, falls back to single-shot
 * `chat()` so existing Q&A behavior is preserved.
 */

import {
  isToolCapable,
} from '../llm/provider.js';
import type {
  LLMProvider,
  ToolCapableProvider,
  ChatMessage,
  ToolCall,
} from '../llm/provider.js';
import { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/index.js';
import { getAgent } from './agents/index.js';
import type { Agent } from './agents/index.js';
import { buildSystemPrompt, buildPerTurnContext } from './prompt.js';
import type { PromptContext } from './prompt.js';
import {
  EventType,
} from './events.js';
import type {
  AnyAgentEvent,
  TurnStartEvent,
  AssistantDeltaEvent,
  ToolProposedEvent,
  ToolFinishedEvent,
  TurnEndEvent,
  ErrorEvent,
  MaxIterationsEvent,
  PermissionRequiredEvent,
  PermissionDecisionEvent,
  CompactionEvent,
  MemorySavedEvent,
} from './events.js';
import { logger } from '../util/logger.js';
// Phase 3 imports
import type { MemoryStore } from './memory/store.js';
import { registerMemoryTools } from './memory/tools.js';
import type { AuditStore } from './audit.js';
import { PermissionEngine } from './permissions.js';
import type { PermissionMode, PermissionDecision } from './permissions.js';
import { withRetry, classifyError } from './retry.js';
import { compactIfNeeded, estimateTokens, DEFAULT_TOKEN_BUDGET } from './compaction.js';

const log = logger.child('agent-engine');

export interface AgentEngineOptions {
  /** The LLM provider to use. */
  provider: LLMProvider;
  /** Tool context (graph store + repo root). */
  toolContext: ToolContext;
  /** Which agent definition to use (default: codebase-analyst). */
  agentName?: string;
  /** Max iterations before forcing a stop (default: from config, 15). */
  maxIterations?: number;
  /** Optional conversation history (prior messages) to continue from. */
  history?: ChatMessage[];
  /** Optional system prompt override (bypasses agent prompt assembly). */
  systemPromptOverride?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  // ── Phase 3 options ──────────────────────────────────────────────
  /** Memory store for persistent facts (optional — enables remember/forget tools). */
  memory?: MemoryStore;
  /** Audit store for recording tool calls (optional — enables audit trail). */
  audit?: AuditStore;
  /** Permission engine for gating write/destructive tools (optional). */
  permissions?: PermissionEngine;
  /** Permission mode — shortcut for creating a PermissionEngine if none provided. */
  permissionMode?: PermissionMode;
  /** Token budget for context compaction (default: 120000). */
  tokenBudget?: number;
  /** Whether to enable context compaction (default: true if tokenBudget set). */
  enableCompaction?: boolean;
}

export interface AgentTurnResult {
  /** The final answer text. */
  answer: string;
  /** Total iterations executed. */
  iterations: number;
  /** Total tool calls made. */
  toolCallsMade: number;
  /** Whether the turn used the fallback (single-shot) path. */
  fallback: boolean;
  /** The full message history including tool calls and results. */
  messages: ChatMessage[];
}

/**
 * The agent engine. One instance per turn (or per session if you reuse
 * the history). Call `run()` to execute a turn — it's an async generator
 * that yields events as they happen, and the final yielded value is the
 * `TurnEndEvent` with the result.
 */
export class AgentEngine {
  private provider: LLMProvider;
  private ctx: ToolContext;
  private agent: Agent;
  private registry: ToolRegistry;
  private maxIterations: number;
  private signal?: AbortSignal;
  private seq = 0;

  // Phase 3 components
  private memory?: MemoryStore;
  private audit?: AuditStore;
  private permissions: PermissionEngine;
  private tokenBudget: number;
  private enableCompaction: boolean;
  /** Pending permission requests awaiting user approval: toolCallId → resolve fn. */
  private pendingPermissions: Map<string, (decision: PermissionDecision) => void> = new Map();

  constructor(opts: AgentEngineOptions) {
    this.provider = opts.provider;
    this.ctx = opts.toolContext;
    this.agent = getAgent(opts.agentName ?? 'codebase-analyst');
    this.registry = this.agent.toolFactory(this.ctx);
    this.maxIterations = opts.maxIterations ?? 15;
    this.signal = opts.signal;
    this.history = opts.history ? [...opts.history] : [];
    this.systemPromptOverride = opts.systemPromptOverride;

    // Phase 3: wire in memory, audit, permissions, compaction
    this.memory = opts.memory;
    this.audit = opts.audit;
    this.permissions = opts.permissions ?? new PermissionEngine(opts.permissionMode ?? 'interactive');
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.enableCompaction = opts.enableCompaction ?? true;

    // Register memory tools if memory store is provided
    if (this.memory) {
      registerMemoryTools(this.registry, this.memory);
      log.debug('Memory tools registered');
    }
  }

  private history: ChatMessage[];
  private systemPromptOverride?: string;

  /**
   * Execute a turn. Yields agent events as they happen.
   * The caller should consume the generator to drive the turn to completion.
   */
  async *run(question: string): AsyncGenerator<AnyAgentEvent, AgentTurnResult, void> {
    const promptCtx: PromptContext = { store: this.ctx.store, repoRoot: this.ctx.repoRoot };
    let systemPrompt = this.systemPromptOverride
      ?? await buildSystemPrompt(this.agent, promptCtx);

    // Phase 3: Inject memory into the system prompt
    if (this.memory) {
      const memoryCtx = await this.memory.buildContext();
      if (memoryCtx) {
        systemPrompt = `${systemPrompt}\n\n${memoryCtx}`;
      }
    }

    // Emit TURN_START
    yield this.event<TurnStartEvent>({
      type: EventType.TURN_START,
      question,
      agent: this.agent.name,
    });

    // If the provider doesn't support tools, fall back to single-shot chat.
    if (!isToolCapable(this.provider)) {
      const result = yield* this.runFallback(question, systemPrompt);
      return result;
    }

    // Tool-capable path: iterative loop
    const result = yield* this.runWithTools(question, systemPrompt);
    return result;
  }

  /**
   * Resolve a pending permission request (called by the UI/API when the user
   * approves or denies a tool call). This unblocks the engine's tool execution.
   */
  resolvePermission(toolCallId: string, decision: 'approved' | 'denied', reason?: string): void {
    const resolve = this.pendingPermissions.get(toolCallId);
    if (resolve) {
      this.permissions.setMode(this.permissions.getMode()); // no-op, just keep mode
      if (decision === 'approved') {
        this.permissions.approve(toolCallId); // Note: this caches by tool name, not call ID
      }
      resolve({
        allow: decision === 'approved',
        deny: decision === 'denied',
        needsUser: false,
        reason: reason ?? (decision === 'approved' ? 'Approved by user.' : 'Denied by user.'),
      });
      this.pendingPermissions.delete(toolCallId);
    }
  }

  /** Get the current permission mode. */
  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

  /** Set the permission mode at runtime. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissions.setMode(mode);
  }

  // ── Tool-capable iterative loop ───────────────────────────────────

  private async *runWithTools(question: string, systemPrompt: string): AsyncGenerator<AnyAgentEvent, AgentTurnResult, void> {
    const toolProvider = this.provider as ToolCapableProvider;
    const tools = this.registry.toOpenAITools();

    // Build the message list: system + history + user question
    const perTurnCtx = buildPerTurnContext({ store: this.ctx.store, repoRoot: this.ctx.repoRoot });
    const userContent = perTurnCtx ? `${question}\n\n${perTurnCtx}` : question;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.history,
      { role: 'user', content: userContent },
    ];

    let iterations = 0;
    let toolCallsMade = 0;
    let finalAnswer = '';

    while (iterations < this.maxIterations) {
      if (this.signal?.aborted) {
        yield this.event<ErrorEvent>({
          type: EventType.ERROR,
          message: 'Turn was cancelled by the user.',
          recoverable: false,
        });
        break;
      }

      // Phase 3: Context compaction — check before each iteration
      if (this.enableCompaction) {
        const tokensBefore = estimateTokens(messages);
        if (tokensBefore > this.tokenBudget * 0.8) {
          const compactionResult = await compactIfNeeded(messages, this.provider, this.tokenBudget);
          if (compactionResult.compacted) {
            // Replace messages in-place
            messages.length = 0;
            messages.push(...compactionResult.messages);
            yield this.event<CompactionEvent>({
              type: EventType.COMPACTION,
              messagesRemoved: compactionResult.messagesRemoved,
              tokensSaved: compactionResult.tokensSaved,
              tokensBefore,
              tokensAfter: estimateTokens(messages),
            });
          }
        }
      }

      iterations++;
      let assistantText = '';
      let pendingToolCalls: ToolCall[] | null = null;

      // Phase 3: Retry with backoff for the streaming call.
      // We can't use withRetry() directly because yield can't be in a callback,
      // so we manually retry on retriable errors before the stream starts.
      let streamAttempt = 0;
      const maxStreamRetries = 2;

      while (true) {
        try {
          assistantText = '';
          pendingToolCalls = null;
          for await (const delta of toolProvider.chatWithTools(messages, tools, this.signal)) {
            if (delta.textDelta) {
              assistantText += delta.textDelta;
              yield this.event<AssistantDeltaEvent>({
                type: EventType.ASSISTANT_DELTA,
                delta: delta.textDelta,
                iteration: iterations - 1,
              });
            }
            if (delta.toolCalls && delta.toolCalls.length > 0) {
              pendingToolCalls = delta.toolCalls;
            }
            if (delta.done) break;
          }
          break; // Success — exit retry loop
        } catch (err: any) {
          if (this.signal?.aborted || err.name === 'AbortError') {
            yield this.event<ErrorEvent>({
              type: EventType.ERROR,
              message: 'Turn was cancelled.',
              recoverable: false,
            });
            // Break out of both loops
            assistantText = '__CANCELLED__';
            break;
          }
          const category = classifyError(err);
          if (streamAttempt < maxStreamRetries && (category === 'network' || category === 'server' || category === 'rate_limit')) {
            streamAttempt++;
            const delay = Math.min(1000 * Math.pow(2, streamAttempt - 1), 5000);
            log.warn(`Stream retry ${streamAttempt}/${maxStreamRetries} after ${delay}ms`, { category, error: err.message });
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          yield this.event<ErrorEvent>({
            type: EventType.ERROR,
            message: `Provider error: ${err.message}`,
            recoverable: false,
          });
          if (assistantText) finalAnswer = assistantText;
          break;
        }
      }

      // Check if cancelled
      if (assistantText === '__CANCELLED__') break;

      // If the assistant made tool calls, execute them and continue the loop
      if (pendingToolCalls && pendingToolCalls.length > 0) {
        // Add the assistant message with tool calls to history
        messages.push({
          role: 'assistant',
          content: assistantText || '',
          tool_calls: pendingToolCalls,
        });

        // Emit TOOL_PROPOSED
        yield this.event<ToolProposedEvent>({
          type: EventType.TOOL_PROPOSED,
          toolCalls: pendingToolCalls,
          iteration: iterations - 1,
        });

        // Phase 3: Permission checks — gate write/destructive tools
        const allowedCalls: ToolCall[] = [];
        const deniedResults: { call: ToolCall; reason: string }[] = [];

        for (const call of pendingToolCalls) {
          const spec = this.registry.get(call.function.name);
          const riskLevel = spec?.riskLevel ?? 'read';
          const decision = this.permissions.check(call.function.name, riskLevel, call);

          if (decision.allow) {
            allowedCalls.push(call);
            if (decision.reason !== 'Read tool: auto-allowed.' && decision.reason !== 'Previously approved by user.') {
              yield this.event<PermissionDecisionEvent>({
                type: EventType.PERMISSION_DECISION,
                toolCallId: call.id,
                toolName: call.function.name,
                decision: 'approved',
                reason: decision.reason,
              });
            }
          } else if (decision.deny) {
            deniedResults.push({ call, reason: decision.reason });
            yield this.event<PermissionDecisionEvent>({
              type: EventType.PERMISSION_DECISION,
              toolCallId: call.id,
              toolName: call.function.name,
              decision: 'denied',
              reason: decision.reason,
            });
          } else if (decision.needsUser) {
            // Emit permission required event and wait for resolution
            yield this.event<PermissionRequiredEvent>({
              type: EventType.PERMISSION_REQUIRED,
              toolCallId: call.id,
              toolName: call.function.name,
              riskLevel,
              args: call.function.arguments,
              reason: decision.reason,
            });

            // Wait for user to approve/deny (with a timeout)
            const userDecision = await this.waitForPermission(call.id);
            if (userDecision.allow) {
              allowedCalls.push(call);
              yield this.event<PermissionDecisionEvent>({
                type: EventType.PERMISSION_DECISION,
                toolCallId: call.id,
                toolName: call.function.name,
                decision: 'approved',
                reason: userDecision.reason,
              });
            } else {
              deniedResults.push({ call, reason: userDecision.reason });
              yield this.event<PermissionDecisionEvent>({
                type: EventType.PERMISSION_DECISION,
                toolCallId: call.id,
                toolName: call.function.name,
                decision: 'denied',
                reason: userDecision.reason,
              });
            }
          }
        }

        // Add denied tool results to messages so the model knows
        for (const { call, reason } of deniedResults) {
          toolCallsMade++;
          messages.push({
            role: 'tool',
            content: `Permission denied: ${reason}`,
            tool_call_id: call.id,
            name: call.function.name,
          });
          yield this.event<ToolFinishedEvent>({
            type: EventType.TOOL_FINISHED,
            toolCallId: call.id,
            toolName: call.function.name,
            success: false,
            result: '',
            error: `Permission denied: ${reason}`,
            durationMs: 0,
          });
          // Phase 3: Audit log
          this.audit?.record({
            agent: this.agent.name,
            toolName: call.function.name,
            toolCallId: call.id,
            args: call.function.arguments,
            success: false,
            result: '',
            error: `Permission denied: ${reason}`,
            durationMs: 0,
            permission: 'denied',
            question,
          });
        }

        // Execute allowed tool calls
        if (allowedCalls.length > 0) {
          const results = await this.executeToolCalls(allowedCalls);

          for (const { call, result, success, error, durationMs } of results) {
            toolCallsMade++;
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            const truncated = resultStr.length > 8000 ? resultStr.slice(0, 8000) + '... [truncated]' : resultStr;

            yield this.event<ToolFinishedEvent>({
              type: EventType.TOOL_FINISHED,
              toolCallId: call.id,
              toolName: call.function.name,
              success,
              result: truncated,
              error,
              durationMs,
            });

            messages.push({
              role: 'tool',
              content: success ? truncated : `Error: ${error}`,
              tool_call_id: call.id,
              name: call.function.name,
            });

            // Phase 3: Audit log
            this.audit?.record({
              agent: this.agent.name,
              toolName: call.function.name,
              toolCallId: call.id,
              args: call.function.arguments,
              success,
              result: truncated,
              error,
              durationMs,
              permission: 'auto-allowed',
              question,
            });

            // Phase 3: Emit MEMORY_SAVED if the tool was "remember"
            if (call.function.name === 'remember' && success && result && typeof result === 'object' && 'id' in result) {
              const r = result as { id: number; message?: string };
              const content = r.message ?? '';
              yield this.event<MemorySavedEvent>({
                type: EventType.MEMORY_SAVED,
                memoryId: r.id,
                scope: 'workspace',
                content: content.slice(0, 200),
              });
            }
          }
        }

        // Continue the loop — the model will process tool results
        continue;
      }

      // No tool calls → this is the final answer
      finalAnswer = assistantText;
      break;
    }

    // Check if we hit the iteration limit
    if (iterations >= this.maxIterations && !finalAnswer) {
      yield this.event<MaxIterationsEvent>({
        type: EventType.MAX_ITERATIONS,
        limit: this.maxIterations,
      });
      finalAnswer = assistantTextFromMessages(messages) || 'I reached the maximum number of reasoning steps without a final answer. Please try rephrasing your question.';
    }

    const result: AgentTurnResult = {
      answer: finalAnswer,
      iterations,
      toolCallsMade,
      fallback: false,
      messages,
    };

    yield this.event<TurnEndEvent>({
      type: EventType.TURN_END,
      answer: finalAnswer,
      iterations,
      toolCallsMade,
      fallback: false,
    });

    return result;
  }

  // ── Fallback: single-shot chat (no tools) ─────────────────────────

  private async *runFallback(question: string, systemPrompt: string): AsyncGenerator<AnyAgentEvent, AgentTurnResult, void> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.history,
      { role: 'user', content: question },
    ];

    let answer = '';
    try {
      // Phase 3: Retry with backoff
      answer = await withRetry(() => this.provider.chat(messages));
      // Emit the full answer as a single delta (no streaming in fallback)
      yield this.event<AssistantDeltaEvent>({
        type: EventType.ASSISTANT_DELTA,
        delta: answer,
        iteration: 0,
      });
    } catch (err: any) {
      yield this.event<ErrorEvent>({
        type: EventType.ERROR,
        message: `Provider error: ${err.message}`,
        recoverable: false,
      });
      answer = `Error: ${err.message}`;
    }

    const result: AgentTurnResult = {
      answer,
      iterations: 1,
      toolCallsMade: 0,
      fallback: true,
      messages,
    };

    yield this.event<TurnEndEvent>({
      type: EventType.TURN_END,
      answer,
      iterations: 1,
      toolCallsMade: 0,
      fallback: true,
    });

    return result;
  }

  // ── Tool execution ────────────────────────────────────────────────

  /**
   * Execute a batch of tool calls. Read-risk tools run concurrently;
   * write/destructive tools run serially. Returns results in the same
   * order as the input calls.
   */
  private async executeToolCalls(
    calls: ToolCall[],
  ): Promise<Array<{ call: ToolCall; result: unknown; success: boolean; error?: string; durationMs: number }>> {
    // Partition by risk level
    const readCalls: { index: number; call: ToolCall }[] = [];
    const writeCalls: { index: number; call: ToolCall }[] = [];

    calls.forEach((call, index) => {
      const spec = this.registry.get(call.function.name);
      if (spec?.riskLevel === 'read') {
        readCalls.push({ index, call });
      } else {
        writeCalls.push({ index, call });
      }
    });

    const results: Array<{ call: ToolCall; result: unknown; success: boolean; error?: string; durationMs: number }> =
      new Array(calls.length);

    // Execute read calls concurrently
    if (readCalls.length > 0) {
      const readResults = await Promise.all(
        readCalls.map(({ call }) => this.executeOne(call)),
      );
      readResults.forEach((r, i) => { results[readCalls[i].index] = r; });
    }

    // Execute write/destructive calls serially
    for (const { call } of writeCalls) {
      const r = await this.executeOne(call);
      results[writeCalls.find(w => w.call === call)!.index] = r;
    }

    return results;
  }

  /** Execute a single tool call with timing and error handling. */
  private async executeOne(call: ToolCall): Promise<{ call: ToolCall; result: unknown; success: boolean; error?: string; durationMs: number }> {
    const start = Date.now();
    const toolName = call.function.name;

    // Parse arguments — with mangled-call diagnosis
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (err: any) {
      const durationMs = Date.now() - start;
      log.warn(`Mangled tool-call arguments for ${toolName}`, { error: err.message, args: call.function.arguments });
      return {
        call,
        result: null,
        success: false,
        error: `Invalid JSON arguments for tool "${toolName}": ${err.message}. Please provide valid JSON.`,
        durationMs,
      };
    }

    try {
      const result = await this.registry.execute(toolName, args);
      const durationMs = Date.now() - start;
      log.debug(`Tool ${toolName} completed`, { durationMs });
      return { call, result, success: true, durationMs };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      log.warn(`Tool ${toolName} failed`, { error: err.message });
      return {
        call,
        result: null,
        success: false,
        error: err.message,
        durationMs,
      };
    }
  }

  // ── Phase 3: Permission waiting ────────────────────────────────────

  /**
   * Wait for a permission decision from the user (via resolvePermission).
   * Times out after 120 seconds with an automatic denial.
   */
  private waitForPermission(toolCallId: string): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      // Set up the resolver
      this.pendingPermissions.set(toolCallId, resolve);

      // Timeout after 120 seconds — auto-deny
      const timeout = setTimeout(() => {
        if (this.pendingPermissions.has(toolCallId)) {
          this.pendingPermissions.delete(toolCallId);
          log.warn(`Permission request timed out for ${toolCallId}`);
          resolve({
            allow: false,
            deny: true,
            needsUser: false,
            reason: 'Permission request timed out (120s). Denied by default.',
          });
        }
      }, 120000);

      // Clean up timeout when resolved
      const originalResolve = resolve;
      const wrappedResolve = (decision: PermissionDecision) => {
        clearTimeout(timeout);
        originalResolve(decision);
      };
      this.pendingPermissions.set(toolCallId, wrappedResolve);
    });
  }

  // ── Event helper ──────────────────────────────────────────────────

  private event<T extends AnyAgentEvent>(base: Omit<T, 'seq' | 'timestamp'>): T {
    return {
      ...base,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
    } as T;
  }
}

/** Extract the last assistant text from a message list (for max-iterations fallback). */
function assistantTextFromMessages(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return '';
}
