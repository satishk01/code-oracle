/**
 * Scripted Provider — Test Helper
 *
 * A deterministic LLM provider for unit-testing the agent loop without any
 * network access. Queue up scripted responses (text, tool calls, or
 * streaming deltas) and the provider replays them in order, one per
 * `chat()` / `chatWithTools()` call.
 *
 * Implements both {@link LLMProvider} (chat) and {@link ToolCapableProvider}
 * (chatWithTools) so it can drive the full AgentEngine tool-calling loop.
 *
 * Inspired by OpenWorker's `ScriptedProvider` (`tests/test_engine.py:34-63`)
 * and the in-repo `ScriptedProvider` in `src/llm/provider.ts`, but with a
 * richer queueing API (queueResponse / queueToolCall / queueStreamDeltas)
 * for more expressive test scenarios.
 */
import type {
  LLMProvider,
  ToolCapableProvider,
  ChatMessage,
  ToolCall,
  StreamDelta,
} from '../../llm/provider.js';
import type { OpenAITool } from '../tools/registry.js';

/** A single queued response. Exactly one of these is consumed per call. */
interface QueuedResponse {
  /** Assistant text content (emitted as a single delta or via chat()). */
  content?: string;
  /** Tool calls the assistant requests. */
  toolCalls?: ToolCall[];
  /** When set, chatWithTools streams these text deltas one-by-one. */
  streamDeltas?: string[];
}

let callIdCounter = 0;

/** Build a ToolCall in the OpenAI format with a unique id. */
function makeToolCall(name: string, args: unknown): ToolCall {
  callIdCounter += 1;
  return {
    id: `call_${callIdCounter}`,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

export class ScriptedTestProvider implements ToolCapableProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-test-model';
  readonly supportsTools = true;

  private queue: QueuedResponse[] = [];
  private callIndex = 0;
  /** All messages passed to chat()/chatWithTools(), in call order. */
  readonly receivedMessages: ChatMessage[][] = [];

  /** Queue a plain text response. */
  queueResponse(text: string): this {
    this.queue.push({ content: text });
    return this;
  }

  /** Queue a tool-call response (optionally with preceding text). */
  queueToolCall(name: string, args: unknown, content?: string): this {
    this.queue.push({ content, toolCalls: [makeToolCall(name, args)] });
    return this;
  }

  /** Queue multiple tool calls in a single response. */
  queueToolCalls(calls: { name: string; args: unknown }[], content?: string): this {
    this.queue.push({
      content,
      toolCalls: calls.map((c) => makeToolCall(c.name, c.args)),
    });
    return this;
  }

  /** Queue a response that streams the given text deltas one at a time. */
  queueStreamDeltas(deltas: string[]): this {
    this.queue.push({ streamDeltas: deltas });
    return this;
  }

  /** Total number of scripted responses queued. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Number of responses consumed so far. */
  get consumed(): number {
    return this.callIndex;
  }

  /** Whether every queued response has been consumed. */
  get exhausted(): boolean {
    return this.callIndex >= this.queue.length;
  }

  async chat(_messages: ChatMessage[]): Promise<string> {
    this.receivedMessages.push(_messages);
    const resp = this.queue[this.callIndex++] ?? { content: 'No more scripted responses.' };
    return resp.content ?? '';
  }

  async *chatWithTools(
    messages: ChatMessage[],
    _tools: OpenAITool[],
    _signal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    this.receivedMessages.push(messages);
    const resp = this.queue[this.callIndex++] ?? { content: 'No more scripted responses.' };

    // Streaming deltas take precedence over a single content string.
    if (resp.streamDeltas) {
      for (const d of resp.streamDeltas) {
        yield { textDelta: d, done: false };
      }
    } else if (resp.content) {
      yield { textDelta: resp.content, done: false };
    }

    if (resp.toolCalls && resp.toolCalls.length > 0) {
      yield { toolCalls: resp.toolCalls, done: false };
    }

    yield { done: true };
  }
}
