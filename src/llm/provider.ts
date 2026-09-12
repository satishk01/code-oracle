/**
 * LLM Provider Abstraction
 *
 * Defines a common interface for chat-based LLM providers so the Q&A layer
 * can swap between Ollama (local) and Omniroute (OpenAI-compatible proxy)
 * via a single config switch.
 *
 * Providers:
 *  - OllamaProvider:   calls Ollama's native /api/chat endpoint
 *  - OmnirouteProvider: calls Omniroute's OpenAI-compatible /v1/chat/completions
 *  - BedrockProvider:  calls AWS Bedrock's OpenAI-compatible endpoint with
 *    SigV4 (IAM) or Bearer (API key) authentication
 *
 * Use {@link createLLMProvider} to build one from config.
 *
 * Phase 1 additions:
 *  - `ToolCapableProvider` interface with `chatWithTools()` for OpenAI-style
 *    tool-calling + streaming deltas.
 *  - `ScriptedProvider` for deterministic tests (no network).
 *  - Existing `chat()` is preserved for backward compatibility.
 */

import type { OpenAITool } from '../agent/tools/registry.js';
import { BedrockProvider, type BedrockAuthMethod } from './bedrock.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Tool calls made by the assistant (OpenAI format). Present when the
   * assistant requests tool execution. Only used with tool-calling.
   */
  tool_calls?: ToolCall[];
  /**
   * The tool call ID this message is a response to (role: "tool" messages).
   * Only used when feeding tool results back to the model.
   */
  tool_call_id?: string;
  /** Name of the tool that produced this result (role: "tool" messages). */
  name?: string;
}

/** A single tool call requested by the assistant (OpenAI format). */
export interface ToolCall {
  /** Unique ID for this tool call (used to correlate the result). */
  id: string;
  /** Always "function" for now. */
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string of arguments. */
    arguments: string;
  };
}

export interface LLMProvider {
  /** Provider name, e.g. "ollama" or "omniroute". */
  readonly name: string;
  /** Model identifier the provider will route to. */
  readonly model: string;
  /** Send a chat request and return the assistant's text response. */
  chat(messages: ChatMessage[]): Promise<string>;
}

/**
 * A provider that supports OpenAI-style tool-calling with streaming.
 * The `chatWithTools` method streams assistant text deltas and tool-call
 * requests as they arrive, enabling the iterative agent loop.
 */
export interface ToolCapableProvider extends LLMProvider {
  /**
   * Whether this provider supports tool-calling. If false, the agent
   * engine falls back to single-shot `chat()`.
   */
  readonly supportsTools: boolean;

  /**
   * Send a chat request with tools available and stream the response.
   * Yields `StreamDelta` events as they arrive from the provider.
   * The final delta will have `done: true`.
   */
  chatWithTools(
    messages: ChatMessage[],
    tools: OpenAITool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta>;
}

/** A streaming chunk from a tool-capable provider. */
export interface StreamDelta {
  /** Incremental text content from the assistant (may be empty). */
  textDelta?: string;
  /** Tool calls requested by the assistant (present when the model wants to call tools). */
  toolCalls?: ToolCall[];
  /** True when this is the final delta in the stream. */
  done: boolean;
}

export interface LLMProviderConfig {
  provider: 'ollama' | 'omniroute' | 'bedrock';
  /** Ollama */
  ollamaUrl: string;
  ollamaModel: string;
  /** Omniroute (OpenAI-compatible) */
  omnirouteUrl: string;
  omnirouteModel: string;
  omnirouteApiKey?: string;
  /** Bedrock */
  bedrockRegion?: string;
  bedrockModel?: string;
  bedrockAuthMethod?: BedrockAuthMethod;
  bedrockAccessKeyId?: string;
  bedrockSecretAccessKey?: string;
  bedrockSessionToken?: string;
  bedrockApiKey?: string;
  bedrockEndpoint?: string;
}

// ── Ollama ──────────────────────────────────────────────────────────

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  protected baseUrl: string;

  constructor(opts: { baseUrl: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: false }),
    });
    if (!resp.ok) throw new Error(`Ollama returned ${resp.status}: ${await resp.text()}`);
    const data = await resp.json() as any;
    return data.message?.content ?? 'No response from model.';
  }
}

/**
 * Ollama with tool-calling support via the OpenAI-compatible `/v1/chat/completions`
 * endpoint (Ollama exposes this alongside the native `/api/chat`). Tool-calling
 * and streaming use the OpenAI SSE format.
 */
export class OllamaToolProvider extends OllamaProvider implements ToolCapableProvider {
  readonly supportsTools = true;

  async *chatWithTools(
    messages: ChatMessage[],
    tools: OpenAITool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`Ollama (OpenAI compat) returned ${resp.status}: ${resp.ok ? '' : await resp.text()}`);
    }
    yield* parseOpenAISSE(resp.body, signal);
  }
}

// ── Omniroute (OpenAI-compatible) ───────────────────────────────────

export class OmnirouteProvider implements ToolCapableProvider {
  readonly name = 'omniroute';
  readonly model: string;
  readonly supportsTools = true;
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.apiKey = opts.apiKey?.trim() || undefined;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 401) {
        throw new Error(
          `Omniroute returned 401 (Unauthorized). The server requires an API key ` +
          `(REQUIRE_API_KEY=true). Set OMNIROUTE_API_KEY in your .env. ` +
          `Response body: ${body}`,
        );
      }
      throw new Error(`Omniroute returned ${resp.status}: ${body}`);
    }
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content ?? 'No response from model.';
  }

  async *chatWithTools(
    messages: ChatMessage[],
    tools: OpenAITool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = resp.ok ? '' : await resp.text();
      if (resp.status === 401) {
        throw new Error(
          `Omniroute returned 401 (Unauthorized). Set OMNIROUTE_API_KEY in your .env. ` +
          `Response body: ${text}`,
        );
      }
      throw new Error(`Omniroute returned ${resp.status}: ${text}`);
    }
    yield* parseOpenAISSE(resp.body, signal);
  }
}

// ── OpenAI SSE stream parser ────────────────────────────────────────

/**
 * Parse an OpenAI-compatible SSE stream (from `/v1/chat/completions` with
 * `stream: true`) into `StreamDelta` events. Handles `data: {...}` lines
 * and the terminal `data: [DONE]` sentinel.
 *
 * Accumulates tool-call argument fragments across chunks (the OpenAI
 * streaming format splits tool-call `arguments` across multiple deltas).
 */
export async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<StreamDelta> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Accumulate tool calls by index across chunks
  const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines (terminated by \n)
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line || line.startsWith(':')) continue; // comment/heartbeat
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          // Emit any accumulated tool calls as a final delta
          if (toolCallAccum.size > 0) {
            yield {
              toolCalls: [...toolCallAccum.values()].map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.args },
              })),
              done: false,
            };
          }
          yield { done: true };
          return;
        }
        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          // Text content
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { textDelta: delta.content, done: false };
          }

          // Tool calls (accumulate fragments by index)
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAccum.get(idx) ?? { id: '', name: '', args: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.args += tc.function.arguments;
              toolCallAccum.set(idx, existing);
            }
          }
        } catch {
          // Ignore malformed JSON lines (keepalive, partial, etc.)
        }
      }
    }
    // Stream ended without [DONE] — emit accumulated tool calls + final
    if (toolCallAccum.size > 0) {
      yield {
        toolCalls: [...toolCallAccum.values()].map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        })),
        done: false,
      };
    }
    yield { done: true };
  } finally {
    reader.releaseLock();
  }
}

// ── ScriptedProvider (for tests) ─────────────────────────────────────

/**
 * A deterministic provider for testing the agent loop without network.
 * Queue up scripted responses (text and/or tool calls) and the provider
 * replays them in order. Inspired by OpenWorker's `ScriptedProvider`.
 */
export interface ScriptedResponse {
  /** Assistant text content. */
  content?: string;
  /** Tool calls for the assistant to request. */
  toolCalls?: ToolCall[];
}

export class ScriptedProvider implements ToolCapableProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-test-model';
  readonly supportsTools = true;
  private queue: ScriptedResponse[];
  private callIndex = 0;

  constructor(responses: ScriptedResponse[]) {
    this.queue = [...responses];
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const resp = this.queue[this.callIndex++] ?? { content: 'No more scripted responses.' };
    return resp.content ?? '';
  }

  async *chatWithTools(
    _messages: ChatMessage[],
    _tools: OpenAITool[],
    _signal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const resp = this.queue[this.callIndex++] ?? { content: 'No more scripted responses.' };
    if (resp.content) {
      yield { textDelta: resp.content, done: false };
    }
    if (resp.toolCalls && resp.toolCalls.length > 0) {
      yield { toolCalls: resp.toolCalls, done: false };
    }
    yield { done: true };
  }

  /** How many scripted responses have been consumed. */
  get consumed(): number {
    return this.callIndex;
  }

  /** Whether all scripted responses have been consumed. */
  get exhausted(): boolean {
    return this.callIndex >= this.queue.length;
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export function createLLMProvider(cfg: LLMProviderConfig): LLMProvider {
  switch (cfg.provider) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: cfg.ollamaUrl, model: cfg.ollamaModel });
    case 'omniroute':
      return new OmnirouteProvider({
        baseUrl: cfg.omnirouteUrl,
        model: cfg.omnirouteModel,
        apiKey: cfg.omnirouteApiKey,
      });
    case 'bedrock':
      return new BedrockProvider({
        region: cfg.bedrockRegion!,
        model: cfg.bedrockModel!,
        authMethod: cfg.bedrockAuthMethod!,
        accessKeyId: cfg.bedrockAccessKeyId,
        secretAccessKey: cfg.bedrockSecretAccessKey,
        sessionToken: cfg.bedrockSessionToken,
        apiKey: cfg.bedrockApiKey,
        endpoint: cfg.bedrockEndpoint,
      });
    default:
      throw new Error(
        `Unknown LLM provider "${cfg.provider}". Supported: ollama, omniroute, bedrock.`,
      );
  }
}

/**
 * Create a tool-capable provider. Returns a `ToolCapableProvider` when the
 * configured provider supports tool-calling, otherwise returns a plain
 * `LLMProvider` (the agent engine will fall back to single-shot `chat()`).
 */
export function createToolCapableProvider(cfg: LLMProviderConfig): LLMProvider | ToolCapableProvider {
  switch (cfg.provider) {
    case 'ollama':
      // Ollama supports tool-calling via its OpenAI-compatible endpoint.
      return new OllamaToolProvider({ baseUrl: cfg.ollamaUrl, model: cfg.ollamaModel });
    case 'omniroute':
      return new OmnirouteProvider({
        baseUrl: cfg.omnirouteUrl,
        model: cfg.omnirouteModel,
        apiKey: cfg.omnirouteApiKey,
      });
    case 'bedrock':
      return new BedrockProvider({
        region: cfg.bedrockRegion!,
        model: cfg.bedrockModel!,
        authMethod: cfg.bedrockAuthMethod!,
        accessKeyId: cfg.bedrockAccessKeyId,
        secretAccessKey: cfg.bedrockSecretAccessKey,
        sessionToken: cfg.bedrockSessionToken,
        apiKey: cfg.bedrockApiKey,
        endpoint: cfg.bedrockEndpoint,
      });
    default:
      throw new Error(
        `Unknown LLM provider "${cfg.provider}". Supported: ollama, omniroute, bedrock.`,
      );
  }
}

/**
 * Type guard: is the given provider tool-capable?
 */
export function isToolCapable(provider: LLMProvider): provider is ToolCapableProvider {
  return 'supportsTools' in provider && (provider as ToolCapableProvider).supportsTools === true;
}
