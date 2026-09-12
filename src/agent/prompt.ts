/**
 * System Prompt Assembly
 *
 * Composes the agent's base system prompt with live repo context:
 *  - Repo environment (root path, node count)
 *  - AGENTS.md conventions (if present in the repo root)
 *  - Live graph stats
 *
 * Inspired by OpenWorker's `build_engine()` prompt assembly
 * (`coworker/agent.py:365-609`). Per OpenWorker's lesson, ephemeral
 * per-turn context is injected into the last user message, not a
 * system message — mid-thread system messages are unreliable across
 * providers.
 */

import fs from 'fs';
import path from 'path';
import { GraphStore } from '../graph/store.js';
import type { Agent } from './agents/index.js';

export interface PromptContext {
  store: GraphStore;
  repoRoot: string;
}

/**
 * Build the full system prompt for the given agent + context.
 * This is set once at the start of a turn (not per-iteration).
 */
export async function buildSystemPrompt(agent: Agent, ctx: PromptContext): Promise<string> {
  const parts: string[] = [agent.systemPrompt];

  // Repo environment
  parts.push(`\n## Repository\nYou are analyzing: ${ctx.repoRoot}`);

  // AGENTS.md conventions (if present)
  const agentsMdPath = path.join(ctx.repoRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) {
    try {
      const content = fs.readFileSync(agentsMdPath, 'utf-8');
      // Truncate very large AGENTS.md files
      const truncated = content.length > 4000
        ? content.slice(0, 4000) + '\n... [truncated]'
        : content;
      parts.push(`\n## Project Conventions (AGENTS.md)\n${truncated}`);
    } catch {
      // Ignore read errors
    }
  }

  // Live graph stats
  try {
    const stats = await ctx.store.getStats();
    const totalNodes = Object.values(stats).reduce((a, b) => a + b, 0);
    if (totalNodes > 0) {
      const statsLine = Object.entries(stats).map(([k, v]) => `${v} ${k}(s)`).join(', ');
      parts.push(`\n## Knowledge Graph Stats\nThe graph contains ${totalNodes} nodes: ${statsLine}.`);
    } else {
      parts.push(`\n## Knowledge Graph Stats\nThe knowledge graph is empty. You may need to ingest the repository first.`);
    }
  } catch {
    // Graph may not be initialized yet
    parts.push(`\n## Knowledge Graph Stats\nGraph stats unavailable (graph may not be initialized).`);
  }

  return parts.join('\n');
}

/**
 * Build ephemeral per-turn context that gets appended to the last user
 * message (not the system prompt). This keeps the context fresh without
 * relying on mid-thread system messages, which are unreliable across
 * providers (OpenWorker lesson).
 *
 * For now this is minimal — it can be extended with live facts, memory,
 * etc. in Phase 3.
 */
export function buildPerTurnContext(_ctx: PromptContext): string {
  // Phase 3 will add memory, live file state, etc.
  return '';
}
