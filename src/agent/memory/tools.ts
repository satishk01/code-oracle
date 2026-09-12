/**
 * Memory Tools
 *
 * Agent tools for interacting with the memory store: `remember`, `forget`,
 * and `search_memory`. These are registered in the tool registry so the
 * agent can save and retrieve facts about the codebase.
 *
 * Inspired by OpenWorker's `coworker/memory/tools.py`.
 */

import { defineTool } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MemoryStore, MemoryScope } from './store.js';

/**
 * Register memory tools (remember, forget, search_memory) into the given
 * registry, backed by the given memory store.
 */
export function registerMemoryTools(registry: ToolRegistry, memory: MemoryStore): void {
  // ── remember ──────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'remember',
    description:
      'Save a fact about the codebase to persistent memory for future reference. ' +
      'Use this when you learn something important about the repo structure, ' +
      'conventions, or architecture that would be useful in future conversations. ' +
      'Examples: "Auth module is in src/auth/", "This repo uses Fastify decorators", ' +
      '"The main entry point is src/index.ts which starts the Express server".',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact to remember. Be specific and concise.',
        },
        scope: {
          type: 'string',
          enum: ['global', 'workspace', 'session'],
          description:
            'Memory scope: "workspace" (default, specific to this repo), ' +
            '"global" (applies to all repos), "session" (only for this conversation).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization (e.g. ["architecture", "auth"]).',
        },
      },
      required: ['content'],
    },
    riskLevel: 'write',
    handler: async (args) => {
      const content = String(args.content ?? '').trim();
      if (!content) return { error: 'content is required' };
      const scope = (String(args.scope ?? 'workspace') as MemoryScope);
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
      const item = await memory.add(scope, content, tags);
      return { success: true, id: item.id, message: `Remembered: ${content.slice(0, 80)}` };
    },
  }));

  // ── forget ────────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'forget',
    description:
      'Remove a memory item by its ID. Use this when a remembered fact is ' +
      'outdated or incorrect.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The ID of the memory item to remove.',
        },
      },
      required: ['id'],
    },
    riskLevel: 'write',
    handler: async (args) => {
      const id = Number(args.id);
      if (!Number.isFinite(id)) return { error: 'id must be a number' };
      const removed = await memory.forget(id);
      return { success: removed, message: removed ? `Forgot item #${id}` : `Item #${id} not found` };
    },
  }));

  // ── search_memory ─────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'search_memory',
    description:
      'Search the agent memory for previously saved facts about the codebase. ' +
      'Use this to recall information learned in previous conversations.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — matched against memory content and tags.',
        },
      },
      required: ['query'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { error: 'query is required' };
      const items = await memory.search(query);
      return {
        count: items.length,
        items: items.map(i => ({
          id: i.id,
          scope: i.scope,
          content: i.content,
          tags: i.tags,
          createdAt: i.createdAt,
        })),
      };
    },
  }));

  // ── list_memory ───────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'list_memory',
    description:
      'List all memory items, optionally filtered by scope. Use this to see ' +
      'what facts the agent has remembered.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'workspace', 'session'],
          description: 'Optional scope filter. If omitted, lists all scopes.',
        },
      },
    },
    riskLevel: 'read',
    handler: async (args) => {
      const scope = args.scope as MemoryScope | undefined;
      const items = await memory.list(scope);
      return {
        count: items.length,
        items: items.map(i => ({
          id: i.id,
          scope: i.scope,
          content: i.content,
          tags: i.tags,
          createdAt: i.createdAt,
        })),
      };
    },
  }));
}
