/**
 * Explorer Agent (Read-Only Subagent)
 *
 * A read-only agent for broad research questions. Has graph tools and
 * file read, but no Cypher access. Inspired by OpenWorker's read-only
 * explorer subagent (`coworker/tools/subagent.py`).
 *
 * In Phase 2 this is defined but not yet spawned as a subagent — that
 * comes in a later phase. For now it can be used directly for research
 * questions where Cypher is not needed.
 */

import { READONLY_CAPABILITIES, filterByCapabilities } from './base.js';
import type { Agent } from './base.js';
import { buildToolRegistry } from '../tools/index.js';
import type { ToolContext } from '../tools/index.js';

export const EXPLORER_PROMPT = `You are a codebase explorer. Your job is to research and gather information about a software repository by querying its knowledge graph and reading source files. You do NOT have access to arbitrary Cypher queries — use the structured tools instead.

Approach broad questions methodically:
1. Search for relevant nodes to understand what exists.
2. Inspect specific nodes and their neighborhoods to understand relationships.
3. Read source files to understand implementation details.
4. Summarize your findings clearly with file paths and entity names.

Be thorough but concise. Report what you found, not what you couldn't find.`;

export const explorerAgent: Agent = {
  name: 'explorer',
  title: 'Codebase Explorer (Read-Only)',
  systemPrompt: EXPLORER_PROMPT,
  capabilities: READONLY_CAPABILITIES,
  toolFactory: (ctx: ToolContext) => {
    const registry = buildToolRegistry(ctx);
    return filterByCapabilities(registry, READONLY_CAPABILITIES);
  },
};
