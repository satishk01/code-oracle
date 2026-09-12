/**
 * Memory Store — Interface
 *
 * Persistent memory for the agent, scoped by global / workspace / session.
 * Stores facts the agent learns about a codebase ("this repo uses Fastify
 * decorators", "auth is in src/auth/"). Injected into the system prompt.
 *
 * Inspired by OpenWorker's `coworker/memory/base.py` — scoped memory with
 * auto "index mode" when the content exceeds 8000 chars.
 *
 * Implementation: JSON-file-backed (not SQLite) to avoid adding a native
 * dependency. The store is simple enough that append/read operations don't
 * need SQL.
 */

export type MemoryScope = 'global' | 'workspace' | 'session';

export interface MemoryItem {
  id: number;
  scope: MemoryScope;
  content: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Optional tags for categorization. */
  tags?: string[];
}

export interface MemoryStore {
  /** Add a memory item. Returns the created item with an assigned ID. */
  add(scope: MemoryScope, content: string, tags?: string[]): Promise<MemoryItem>;

  /** Remove a memory item by ID. Returns true if it was removed. */
  forget(id: number): Promise<boolean>;

  /** List all memory items, optionally filtered by scope. */
  list(scope?: MemoryScope): Promise<MemoryItem[]>;

  /** Search memory items by content substring. */
  search(query: string): Promise<MemoryItem[]>;

  /** Clear all items in a scope (or all if no scope given). */
  clear(scope?: MemoryScope): Promise<void>;

  /**
   * Build the memory context string for injection into the system prompt.
   * If the total content exceeds `maxChars`, switches to "index mode" —
   * shows only item IDs + first line + tags so the agent can retrieve
   * specific items via the search tool.
   */
  buildContext(maxChars?: number): Promise<string>;

  /** Close the store (release any resources). */
  close(): Promise<void>;
}

/** Default max chars before switching to index mode. */
export const MEMORY_INDEX_THRESHOLD = 8000;
