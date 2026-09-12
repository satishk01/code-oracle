/**
 * AgentEngine unit tests.
 *
 * Uses the scripted test provider (no network) to drive the iterative
 * agent loop deterministically. Covers:
 *  - basic single-turn (no tools)
 *  - tool-call loop (tool call → result → final answer)
 *  - fallback path (provider without tool support)
 *  - max iterations limit
 */
import { describe, it, expect } from 'vitest';
import { AgentEngine } from '../engine.js';
import type { AgentTurnResult } from '../engine.js';
import { EventType } from '../events.js';
import type { AnyAgentEvent } from '../events.js';
import type { ToolContext } from '../tools/index.js';
import type { GraphStore } from '../../graph/store.js';
import { ScriptedTestProvider } from './scripted-provider.js';
import type { LLMProvider, ChatMessage } from '../../llm/provider.js';

/**
 * Minimal stub store. Only `getStats` is exercised by the get_graph_stats
 * tool handler; other methods are stubs that return empty results so the
 * registry builds without a real KuzuDB instance.
 */
function makeStubStore(): GraphStore {
  const stub: any = {
    async getStats() {
      return { Module: 1, Function: 2 };
    },
    async search() {
      return [];
    },
    async getNode() {
      return null;
    },
    async getNeighborhood() {
      return { nodes: [], edges: [] };
    },
    async getNodesByKind() {
      return [];
    },
    async getNodesByFile() {
      return [];
    },
    async getDependents() {
      return [];
    },
    async runCypher() {
      return [];
    },
  };
  return stub as unknown as GraphStore;
}

function makeCtx(): ToolContext {
  return {
    store: makeStubStore(),
    repoRoot: process.cwd(),
  };
}

/** Drain an AgentEngine run generator, collecting events and the final result. */
async function runTurn(
  engine: AgentEngine,
  question: string,
): Promise<{ events: AnyAgentEvent[]; result: AgentTurnResult }> {
  const events: AnyAgentEvent[] = [];
  const gen = engine.run(question);
  let result: AgentTurnResult | undefined;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      result = value as AgentTurnResult;
      break;
    }
    events.push(value as AnyAgentEvent);
  }
  return { events, result: result! };
}

function eventTypes(events: AnyAgentEvent[]): EventType[] {
  return events.map((e) => e.type);
}

describe('AgentEngine', () => {
  describe('basic turn (no tool calls)', () => {
    it('returns the scripted answer with iterations=1 and no tool calls', async () => {
      const provider = new ScriptedTestProvider();
      provider.queueResponse('The graph has 3 modules.');

      const engine = new AgentEngine({
        provider,
        toolContext: makeCtx(),
        systemPromptOverride: 'You are a test agent.',
        maxIterations: 5,
        enableCompaction: false,
      });

      const { events, result } = await runTurn(engine, 'How many modules?');

      expect(result.fallback).toBe(false);
      expect(result.iterations).toBe(1);
      expect(result.toolCallsMade).toBe(0);
      expect(result.answer).toBe('The graph has 3 modules.');

      const types = eventTypes(events);
      expect(types).toContain(EventType.TURN_START);
      expect(types).toContain(EventType.ASSISTANT_DELTA);
      expect(types).toContain(EventType.TURN_END);
      expect(types).not.toContain(EventType.TOOL_PROPOSED);

      const end = events.find((e) => e.type === EventType.TURN_END)!;
      expect((end as any).answer).toBe('The graph has 3 modules.');
    });

    it('streams multiple deltas when queueStreamDeltas is used', async () => {
      const provider = new ScriptedTestProvider();
      provider.queueStreamDeltas(['Hello', ' ', 'world']);

      const engine = new AgentEngine({
        provider,
        toolContext: makeCtx(),
        systemPromptOverride: 'test',
        maxIterations: 5,
        enableCompaction: false,
      });

      const { events, result } = await runTurn(engine, 'hi');

      const deltas = events
        .filter((e) => e.type === EventType.ASSISTANT_DELTA)
        .map((e) => (e as any).delta);
      expect(deltas).toEqual(['Hello', ' ', 'world']);
      expect(result.answer).toBe('Hello world');
    });
  });

  describe('tool-call loop', () => {
    it('executes a tool call, feeds the result back, and returns the final answer', async () => {
      const provider = new ScriptedTestProvider();
      // 1st call: assistant requests the get_graph_stats tool
      provider.queueToolCall('get_graph_stats', {}, 'Let me check the graph stats.');
      // 2nd call: assistant produces the final answer using the tool result
      provider.queueResponse('Based on the graph, there are 1 module and 2 functions.');

      const engine = new AgentEngine({
        provider,
        toolContext: makeCtx(),
        systemPromptOverride: 'test',
        maxIterations: 5,
        enableCompaction: false,
      });

      const { events, result } = await runTurn(engine, 'How many modules?');

      expect(result.fallback).toBe(false);
      expect(result.toolCallsMade).toBe(1);
      expect(result.iterations).toBe(2);
      expect(result.answer).toBe('Based on the graph, there are 1 module and 2 functions.');

      const types = eventTypes(events);
      expect(types).toContain(EventType.TOOL_PROPOSED);
      expect(types).toContain(EventType.TOOL_FINISHED);

      const finished = events.find((e) => e.type === EventType.TOOL_FINISHED)! as any;
      expect(finished.toolName).toBe('get_graph_stats');
      expect(finished.success).toBe(true);

      // The tool result should be present in the final message history.
      const toolMessages = result.messages.filter((m) => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].name).toBe('get_graph_stats');
    });
  });

  describe('fallback path (provider without tool support)', () => {
    it('uses single-shot chat() and marks fallback=true', async () => {
      // A plain LLMProvider with no supportsTools property.
      const plainProvider: LLMProvider = {
        name: 'plain',
        model: 'plain-model',
        async chat(_messages: ChatMessage[]) {
          return 'Single-shot answer.';
        },
      };

      const engine = new AgentEngine({
        provider: plainProvider,
        toolContext: makeCtx(),
        systemPromptOverride: 'test',
        maxIterations: 5,
        enableCompaction: false,
      });

      const { events, result } = await runTurn(engine, 'Anything?');

      expect(result.fallback).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.toolCallsMade).toBe(0);
      expect(result.answer).toBe('Single-shot answer.');

      const types = eventTypes(events);
      expect(types).not.toContain(EventType.TOOL_PROPOSED);
      expect(types).toContain(EventType.TURN_END);
    });
  });

  describe('max iterations', () => {
    it('stops after maxIterations of continuous tool calls and emits MAX_ITERATIONS', async () => {
      const provider = new ScriptedTestProvider();
      // Queue more tool-call responses than iterations allowed.
      provider.queueToolCall('get_graph_stats', {});
      provider.queueToolCall('get_graph_stats', {});
      provider.queueToolCall('get_graph_stats', {});

      const engine = new AgentEngine({
        provider,
        toolContext: makeCtx(),
        systemPromptOverride: 'test',
        maxIterations: 2,
        enableCompaction: false,
      });

      const { events, result } = await runTurn(engine, 'Keep calling tools.');

      expect(result.iterations).toBe(2);
      expect(result.toolCallsMade).toBe(2);
      expect(result.fallback).toBe(false);

      const types = eventTypes(events);
      expect(types).toContain(EventType.MAX_ITERATIONS);
      expect(types).toContain(EventType.TURN_END);
    });
  });
});
