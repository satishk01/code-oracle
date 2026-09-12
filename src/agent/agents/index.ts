/**
 * Agent Registry
 *
 * Central lookup for available agents by name. Inspired by OpenWorker's
 * `coworker/agents/registry.py`.
 */

import { Agent } from './base.js';
import { codebaseAnalystAgent } from './codebase-analyst.js';
import { explorerAgent } from './explorer.js';

export type { Agent, AgentCapabilities } from './base.js';
export { FULL_CAPABILITIES, READONLY_CAPABILITIES, filterByCapabilities } from './base.js';
export { codebaseAnalystAgent, CODEBASE_ANALYST_PROMPT } from './codebase-analyst.js';
export { explorerAgent, EXPLORER_PROMPT } from './explorer.js';

const agents = new Map<string, Agent>([
  [codebaseAnalystAgent.name, codebaseAnalystAgent],
  [explorerAgent.name, explorerAgent],
]);

/** Get an agent by name. Defaults to the codebase analyst. */
export function getAgent(name: string = 'codebase-analyst'): Agent {
  const agent = agents.get(name);
  if (!agent) throw new Error(`Unknown agent: ${name}. Available: ${[...agents.keys()].join(', ')}`);
  return agent;
}

/** List all registered agent names. */
export function listAgents(): string[] {
  return [...agents.keys()];
}
