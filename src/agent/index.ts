/**
 * Agent module — public API
 *
 * Re-exports the agent engine, tool registry, agent definitions, events,
 * and prompt assembly. This is the single import point for consumers
 * (e.g. the API server).
 */

export { AgentEngine } from './engine.js';
export type { AgentEngineOptions, AgentTurnResult } from './engine.js';
export { ToolRegistry, defineTool } from './tools/registry.js';
export type { ToolSpec, ToolSchema, OpenAITool, RiskLevel, DefineToolOptions } from './tools/registry.js';
export { buildToolRegistry } from './tools/index.js';
export type { ToolContext } from './tools/index.js';
export { FULL_CAPABILITIES, READONLY_CAPABILITIES, getAgent, listAgents, codebaseAnalystAgent, explorerAgent } from './agents/index.js';
export type { Agent, AgentCapabilities } from './agents/index.js';
export { buildSystemPrompt, buildPerTurnContext } from './prompt.js';
export type { PromptContext } from './prompt.js';
export { EventType, eventToSSE } from './events.js';
export type {
  AnyAgentEvent, TurnStartEvent, AssistantDeltaEvent, ToolProposedEvent,
  ToolFinishedEvent, TurnEndEvent, ErrorEvent, MaxIterationsEvent,
  PermissionRequiredEvent, PermissionDecisionEvent, CompactionEvent, MemorySavedEvent,
} from './events.js';
// Phase 3 exports
export { JsonMemoryStore } from './memory/sqlite.js';
export type { MemoryStore, MemoryItem, MemoryScope } from './memory/store.js';
export { registerMemoryTools } from './memory/tools.js';
export { AuditStore } from './audit.js';
export type { AuditEntry } from './audit.js';
export { PermissionEngine, modeDescription } from './permissions.js';
export type { PermissionMode, PermissionDecision } from './permissions.js';
export { withRetry, classifyError, friendlyErrorMessage, isRetriable } from './retry.js';
export type { ErrorCategory, RetryOptions } from './retry.js';
export { compactIfNeeded, estimateTokens, DEFAULT_TOKEN_BUDGET } from './compaction.js';
export type { CompactionResult } from './compaction.js';
