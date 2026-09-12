// ── Shared types for codebase-oracle frontend components ───────────

// Re-export types from the api hook so components have a single import source
export type {
  RepoInfo,
  RepoEntry,
  MemoryItem,
  AuditEntry,
  AgentStreamEvent,
  ToolCallInfo,
} from '../hooks/useApi';

// ── Graph types ────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  description: string;
  metadata: string;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
}

// ── Q&A streaming types ────────────────────────────────────────────
export interface ToolActivity {
  id: string;
  name: string;
  args?: string;
  status: 'proposed' | 'running' | 'done' | 'error';
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface QaExchange {
  q: string;
  a: string;
  model: string;
  tools?: ToolActivity[];
  iterations?: number;
  fallback?: boolean;
}

// ── Phase 3: Permission request ────────────────────────────────────
export interface PendingPermission {
  toolCallId: string;
  toolName: string;
  riskLevel: string;
  args: string;
  reason: string;
}
