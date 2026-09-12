const BASE = '/api';

// ── Agent Stream Event Types ───────────────────────────────────────
// These mirror the backend event types from src/agent/events.ts

export type AgentEventType =
  | 'turn_start'
  | 'assistant_delta'
  | 'tool_proposed'
  | 'tool_finished'
  | 'turn_end'
  | 'error'
  | 'max_iterations'
  | 'permission_required'
  | 'permission_decision'
  | 'compaction'
  | 'memory_saved';

export interface ToolCallInfo {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AgentStreamEvent {
  type: AgentEventType;
  seq: number;
  timestamp: string;
  // turn_start
  question?: string;
  agent?: string;
  // assistant_delta
  delta?: string;
  iteration?: number;
  // tool_proposed
  toolCalls?: ToolCallInfo[];
  // tool_finished
  toolCallId?: string;
  toolName?: string;
  success?: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
  // turn_end
  answer?: string;
  iterations?: number;
  toolCallsMade?: number;
  fallback?: boolean;
  // error
  message?: string;
  recoverable?: boolean;
  // max_iterations
  limit?: number;
  // permission_required
  riskLevel?: string;
  // permission_decision
  decision?: 'approved' | 'denied';
  // compaction
  messagesRemoved?: number;
  tokensSaved?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  // memory_saved
  memoryId?: number;
  scope?: string;
}

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!resp.ok) {
    let msg = `API error: ${resp.status}`;
    try {
      const body = await resp.json();
      if (body.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

export interface RepoInfo {
  repoRoot: string;
  indexed: boolean;
  hasHashCache: boolean;
  nodeCount: number;
  edgeCount: number;
}

export interface RepoEntry {
  path: string;
  name: string;
  lastIndexed: string | null;
  nodeCount: number;
  edgeCount: number;
  filesProcessed: number;
  exists: boolean;
}

export const api = {
  health: () => fetchJson<{ status: string; repoRoot: string; llmProvider: string; llmModel: string }>('/health'),
  /** List all known/indexed repos */
  listRepos: () => fetchJson<{ repos: RepoEntry[]; activeRepo: string }>('/repos'),
  /** Remove a repo from the registry, optionally delete indexed data */
  removeRepo: (repoRoot: string, deleteData: boolean = false) =>
    fetchJson<{ success: boolean; switchedTo?: string }>('/repos', {
      method: 'DELETE',
      body: JSON.stringify({ repoRoot, deleteData }),
    }),
  getRepo: () => fetchJson<RepoInfo>('/repo'),
  setRepo: (repoRoot: string) =>
    fetchJson<RepoInfo>('/repo', {
      method: 'POST',
      body: JSON.stringify({ repoRoot }),
    }),
  ingest: (opts: { incremental?: boolean; full?: boolean; repoRoot?: string; useLlmEnrichment?: boolean } = {}) =>
    fetchJson<any>('/ingest', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  getGraph: () => fetchJson<{ nodes: any[]; edges: any[] }>('/graph'),
  getStats: () => fetchJson<{ stats: Record<string, number>; patterns: any[]; endpoints: any[] }>('/stats'),
  search: (q: string) => fetchJson<{ results: any[] }>(`/search?q=${encodeURIComponent(q)}`),
  getNode: (id: string) => fetchJson<{ node: any; neighborhood: any }>(`/node/${encodeURIComponent(id)}`),

  // ── Impact Analysis ──────────────────────────────────────────────────
  /** Code-based impact analysis (based on file changes) */
  impact: (changes: { filePath: string; type: string }[], useLlm?: boolean) =>
    fetchJson<any>('/impact', {
      method: 'POST',
      body: JSON.stringify({ changes, useLlm }),
    }),
  /** Requirement-based impact analysis (based on text requirement) */
  requirementImpact: (requirement: string, useLlm?: boolean) =>
    fetchJson<any>('/requirement-impact', {
      method: 'POST',
      body: JSON.stringify({ requirement, useLlm }),
    }),
  latestImpact: () => fetchJson<any>('/impact/latest'),

  ask: (question: string) =>
    fetchJson<any>('/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),

  /**
   * Agentic streaming Q&A via SSE.
   *
   * Calls the `/api/ask/stream` endpoint and consumes the Server-Sent Events
   * stream. Each event is parsed and passed to the `onEvent` callback as it
   * arrives, enabling real-time UI updates (streaming text, tool call cards,
   * activity indicators).
   *
   * Returns when the stream ends (after a `turn_end` event).
   *
   * @param question  The question to ask
   * @param onEvent   Callback invoked for each agent event
   * @param signal    Optional AbortSignal to cancel the stream
   */
  askStream: async (
    question: string,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const resp = await fetch(`${BASE}/ask/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal,
    });
    if (!resp.ok || !resp.body) {
      let msg = `API error: ${resp.status}`;
      try { const b = await resp.json(); if (b.error) msg = b.error; } catch {}
      throw new Error(msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (separated by \n\n)
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sepIdx).trim();
        buffer = buffer.slice(sepIdx + 2);
        if (!raw.startsWith('data:')) continue;
        const jsonStr = raw.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const event = JSON.parse(jsonStr) as AgentStreamEvent;
          onEvent(event);
        } catch {
          // Ignore malformed JSON
        }
      }
    }
  },

  // ── Documentation ────────────────────────────────────────────────────
  /** Preview docs (returns JSON with content). */
  previewDocs: (format: 'md' | 'html', categories?: string[], includeLlmSummary?: boolean) =>
    fetchJson<{ content: string; format: string; filename: string }>(
      `/docs/preview?format=${format}${categories ? `&categories=${categories.join(',')}` : ''}${includeLlmSummary ? '&llm=true' : ''}`,
    ),
  /** Download docs as a file (triggers browser download). */
  downloadDocs: (format: 'md' | 'html', categories?: string[], includeLlmSummary?: boolean) => {
    window.open(`${BASE}/docs/generate?format=${format}${categories ? `&categories=${categories.join(',')}` : ''}${includeLlmSummary ? '&llm=true' : ''}`, '_blank');
  },

  /** Browse directories at a path (for folder picker). */
  browse: (dirPath?: string) =>
    fetchJson<{
      path: string;
      parent: string | null;
      isRoot: boolean;
      dirs: { name: string; path: string; hasSubdirs: boolean }[];
    }>(`/browse${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`),

  // ── Phase 3: Memory API ──────────────────────────────────────────
  listMemory: () =>
    fetchJson<{ items: MemoryItem[]; count: number }>('/memory'),
  addMemory: (content: string, scope?: string, tags?: string[]) =>
    fetchJson<{ success: boolean; item: MemoryItem }>('/memory', {
      method: 'POST',
      body: JSON.stringify({ content, scope, tags }),
    }),
  deleteMemory: (id: number) =>
    fetchJson<{ success: boolean }>(`/memory/${id}`, { method: 'DELETE' }),
  searchMemory: (q: string) =>
    fetchJson<{ items: MemoryItem[]; count: number }>(`/memory/search?q=${encodeURIComponent(q)}`),
  clearMemory: (scope?: string) =>
    fetchJson<{ success: boolean }>('/memory', { method: 'DELETE', body: JSON.stringify({ scope }) }),

  // ── Phase 3: Audit Log API ───────────────────────────────────────
  listAudit: () =>
    fetchJson<{ entries: AuditEntry[]; count: number; total: number }>('/audit'),
  clearAudit: () =>
    fetchJson<{ success: boolean }>('/audit', { method: 'DELETE' }),

  // ── Phase 3: Permission API ──────────────────────────────────────
  getPermissionMode: () =>
    fetchJson<{ mode: string; description: string }>('/permission/mode'),
  setPermissionMode: (mode: string) =>
    fetchJson<{ mode: string; description: string }>('/permission/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  resolvePermission: (engineId: string, toolCallId: string, decision: 'approved' | 'denied', reason?: string) =>
    fetchJson<{ success: boolean }>('/permission/resolve', {
      method: 'POST',
      body: JSON.stringify({ engineId, toolCallId, decision, reason }),
    }),
};

// ── Phase 3: Types ─────────────────────────────────────────────────

export interface MemoryItem {
  id: number;
  scope: string;
  content: string;
  tags?: string[];
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  agent: string;
  toolName: string;
  toolCallId: string;
  args: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
  permission: string;
  question: string;
}
