/**
 * Declarative Agent Definitions
 *
 * Inspired by OpenWorker's `coworker/agents/base.py` — agents are simple
 * declarative objects with a system prompt, a tool factory, and capability
 * flags. The AgentEngine uses these to assemble a turn.
 */

import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/index.js';

/**
 * Capability flags that control what an agent can do. Mirrors OpenWorker's
 * `Agent` dataclass flags (`requires_folder`, `subagents`, `scheduling`, etc.)
 * but adapted for codebase analysis.
 */
export interface AgentCapabilities {
  /** Whether the agent can read files from the repo. */
  fileRead: boolean;
  /** Whether the agent can query the graph. */
  graphQuery: boolean;
  /** Whether the agent can run impact analysis. */
  impactAnalysis: boolean;
  /** Whether the agent can run arbitrary Cypher. */
  cypher: boolean;
}

/** Default capabilities for a full codebase analyst. */
export const FULL_CAPABILITIES: AgentCapabilities = {
  fileRead: true,
  graphQuery: true,
  impactAnalysis: true,
  cypher: true,
};

/** Read-only capabilities for the explorer subagent. */
export const READONLY_CAPABILITIES: AgentCapabilities = {
  fileRead: true,
  graphQuery: true,
  impactAnalysis: true,
  cypher: false,
};

/**
 * A declarative agent definition. The `toolFactory` builds the tool
 * registry for a given context; the `systemPrompt` is the base prompt
 * (augmented at runtime with repo context).
 */
export interface Agent {
  /** Unique agent name. */
  name: string;
  /** Human-readable title for display. */
  title: string;
  /** Base system prompt — augmented with repo context at runtime. */
  systemPrompt: string;
  /** Capability flags. */
  capabilities: AgentCapabilities;
  /**
   * Build the tool registry for this agent given a tool context.
   * Returns a registry with only the tools this agent is allowed to use.
   */
  toolFactory: (ctx: ToolContext) => ToolRegistry;
}

/**
 * Filter a full tool registry down to the tools allowed by the given
 * capabilities. Used by agent tool factories to enforce capability flags.
 */
export function filterByCapabilities(
  registry: ToolRegistry,
  caps: AgentCapabilities,
): ToolRegistry {
  // The tools/index.ts buildToolRegistry already creates all tools as 'read'
  // risk level. We filter by name based on capabilities.
  // If cypher is disabled, disable the run_cypher tool.
  if (!caps.cypher) registry.disable('run_cypher');
  if (!caps.impactAnalysis) registry.disable('analyze_impact');
  if (!caps.fileRead) {
    registry.disable('read_file');
    registry.disable('list_files');
  }
  if (!caps.graphQuery) {
    registry.disable('search_nodes');
    registry.disable('get_node');
    registry.disable('get_nodes_by_kind');
    registry.disable('get_nodes_by_file');
    registry.disable('get_dependents');
    registry.disable('get_graph_stats');
  }
  return registry;
}
