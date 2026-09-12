/**
 * Agent Event Definitions
 *
 * Defines the event types emitted by the AgentEngine during a turn.
 * These events drive the streaming UI (SSE) and the audit log.
 *
 * Inspired by OpenWorker's `coworker/events.py` — an event bus with
 * typed events for turn start/end, assistant deltas, tool proposals,
 * tool completion, and errors.
 */

import type { ToolCall } from '../llm/provider.js';

export enum EventType {
  /** A new turn (user message) has started. */
  TURN_START = 'turn_start',
  /** The assistant produced a text delta (streaming). */
  ASSISTANT_DELTA = 'assistant_delta',
  /** The assistant is requesting one or more tool calls. */
  TOOL_PROPOSED = 'tool_proposed',
  /** A tool call has finished executing. */
  TOOL_FINISHED = 'tool_finished',
  /** The turn has ended (final answer ready or iteration limit hit). */
  TURN_END = 'turn_end',
  /** An error occurred during the turn. */
  ERROR = 'error',
  /** The iteration limit was reached without a final answer. */
  MAX_ITERATIONS = 'max_iterations',
  // ── Phase 3 events ──────────────────────────────────────────────
  /** A tool call requires user permission before proceeding. */
  PERMISSION_REQUIRED = 'permission_required',
  /** A permission decision was made (approved/denied). */
  PERMISSION_DECISION = 'permission_decision',
  /** Context compaction was triggered (older messages summarized). */
  COMPACTION = 'compaction',
  /** A memory item was saved. */
  MEMORY_SAVED = 'memory_saved',
}

/** Base event shape. */
export interface AgentEvent {
  type: EventType;
  /** Monotonic event sequence number within a turn. */
  seq: number;
  /** ISO timestamp. */
  timestamp: string;
}

export interface TurnStartEvent extends AgentEvent {
  type: EventType.TURN_START;
  question: string;
  /** The agent name handling this turn. */
  agent: string;
}

export interface AssistantDeltaEvent extends AgentEvent {
  type: EventType.ASSISTANT_DELTA;
  /** Incremental text from the assistant. */
  delta: string;
  /** The iteration number within the agent loop (0-indexed). */
  iteration: number;
}

export interface ToolProposedEvent extends AgentEvent {
  type: EventType.TOOL_PROPOSED;
  /** The tool calls the assistant wants to make. */
  toolCalls: ToolCall[];
  iteration: number;
}

export interface ToolFinishedEvent extends AgentEvent {
  type: EventType.TOOL_FINISHED;
  /** The tool call ID that completed. */
  toolCallId: string;
  /** Tool name. */
  toolName: string;
  /** Whether the tool succeeded or errored. */
  success: boolean;
  /** The result (serialized to string, truncated for display). */
  result: string;
  /** Error message if the tool failed. */
  error?: string;
  /** Execution time in milliseconds. */
  durationMs: number;
}

export interface TurnEndEvent extends AgentEvent {
  type: EventType.TURN_END;
  /** The final answer text. */
  answer: string;
  /** Total iterations executed. */
  iterations: number;
  /** Total tool calls made. */
  toolCallsMade: number;
  /** Whether the turn ended due to fallback (no tool support). */
  fallback: boolean;
}

export interface ErrorEvent extends AgentEvent {
  type: EventType.ERROR;
  message: string;
  /** Whether the error is recoverable (the loop will continue). */
  recoverable: boolean;
}

export interface MaxIterationsEvent extends AgentEvent {
  type: EventType.MAX_ITERATIONS;
  /** The iteration limit that was hit. */
  limit: number;
}

// ── Phase 3 event types ───────────────────────────────────────────

export interface PermissionRequiredEvent extends AgentEvent {
  type: EventType.PERMISSION_REQUIRED;
  /** The tool call ID that needs approval. */
  toolCallId: string;
  /** Tool name. */
  toolName: string;
  /** Risk level: "read" | "write" | "destructive". */
  riskLevel: string;
  /** Arguments the tool wants to use (JSON string). */
  args: string;
  /** Human-readable reason for the permission request. */
  reason: string;
}

export interface PermissionDecisionEvent extends AgentEvent {
  type: EventType.PERMISSION_DECISION;
  /** The tool call ID. */
  toolCallId: string;
  /** Tool name. */
  toolName: string;
  /** The decision: "approved" or "denied". */
  decision: 'approved' | 'denied';
  /** Reason for the decision. */
  reason: string;
}

export interface CompactionEvent extends AgentEvent {
  type: EventType.COMPACTION;
  /** Number of older messages that were summarized. */
  messagesRemoved: number;
  /** Estimated tokens saved. */
  tokensSaved: number;
  /** Estimated token count before compaction. */
  tokensBefore: number;
  /** Estimated token count after compaction. */
  tokensAfter: number;
}

export interface MemorySavedEvent extends AgentEvent {
  type: EventType.MEMORY_SAVED;
  /** Memory item ID. */
  memoryId: number;
  /** Memory scope. */
  scope: string;
  /** Content (truncated for display). */
  content: string;
}

/** Union of all agent event types. */
export type AnyAgentEvent =
  | TurnStartEvent
  | AssistantDeltaEvent
  | ToolProposedEvent
  | ToolFinishedEvent
  | TurnEndEvent
  | ErrorEvent
  | MaxIterationsEvent
  | PermissionRequiredEvent
  | PermissionDecisionEvent
  | CompactionEvent
  | MemorySavedEvent;

/** Serialize an agent event to an SSE `data:` line (JSON string). */
export function eventToSSE(event: AnyAgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
