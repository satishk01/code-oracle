import { useState } from 'react';
import {
  AlertCircle, AlertTriangle, Cpu, Database, RefreshCw, Send,
  Terminal, Wrench, X, Check, ChevronUp, ChevronDown,
} from 'lucide-react';
import type { MemoryItem, AuditEntry, PendingPermission } from './types';

export function AgentTab({
  memoryItems, auditEntries, permissionMode, permissionDesc,
  pendingPermissions, compactionNotices,
  onRefresh, onAddMemory, onDeleteMemory, onClearMemory,
  onSetPermissionMode, onClearAudit, onResolvePermission, onDismissNotice,
}: {
  memoryItems: MemoryItem[];
  auditEntries: AuditEntry[];
  permissionMode: string;
  permissionDesc: string;
  pendingPermissions: PendingPermission[];
  compactionNotices: string[];
  onRefresh: () => void;
  onAddMemory: (content: string, scope?: string) => Promise<void>;
  onDeleteMemory: (id: number) => Promise<void>;
  onClearMemory: () => Promise<void>;
  onSetPermissionMode: (mode: string) => Promise<void>;
  onClearAudit: () => Promise<void>;
  onResolvePermission: (toolCallId: string, decision: 'approved' | 'denied') => Promise<void>;
  onDismissNotice: (idx: number) => void;
}) {
  const [newMemory, setNewMemory] = useState('');
  const [newMemoryScope, setNewMemoryScope] = useState('workspace');
  const [auditFilter, setAuditFilter] = useState('');

  const permModes = [
    { id: 'discuss', label: 'Discuss', desc: 'No tools allowed' },
    { id: 'plan', label: 'Plan', desc: 'Read-only tools' },
    { id: 'interactive', label: 'Interactive', desc: 'Ask for writes' },
    { id: 'auto-approve', label: 'Auto-approve', desc: 'No prompts' },
    { id: 'bypass', label: 'Bypass', desc: 'All tools (testing)' },
  ];

  const filteredAudit = auditFilter
    ? auditEntries.filter(e =>
        e.toolName.includes(auditFilter) ||
        e.question.includes(auditFilter) ||
        e.permission.includes(auditFilter))
    : auditEntries;

  return (
    <div className="tab-content agent-tab">
      <h1>Agent Control Center</h1>
      <p className="tab-desc">Manage agent memory, permissions, and audit trail.</p>

      {/* Compaction notices */}
      {compactionNotices.length > 0 && (
        <div className="agent-notices">
          {compactionNotices.map((notice, i) => (
            <div key={i} className="agent-notice" onClick={() => onDismissNotice(i)}>
              <AlertCircle size={14} />
              <span>{notice}</span>
              <X size={12} className="dismiss-btn" />
            </div>
          ))}
        </div>
      )}

      {/* Pending permissions */}
      {pendingPermissions.length > 0 && (
        <div className="agent-pending-perms">
          <h2><AlertTriangle size={18} /> Pending Permission Requests</h2>
          {pendingPermissions.map((p, i) => (
            <div key={i} className="pending-perm-card">
              <div className="pending-perm-header">
                <Wrench size={16} />
                <span className="pending-perm-tool">{p.toolName}</span>
                <span className={`pending-perm-risk risk-${p.riskLevel}`}>{p.riskLevel}</span>
              </div>
              <div className="pending-perm-reason">{p.reason}</div>
              {p.args && (
                <pre className="pending-perm-args">{p.args}</pre>
              )}
              <div className="pending-perm-actions">
                <button className="perm-approve-btn" onClick={() => onResolvePermission(p.toolCallId, 'approved')}>
                  <Check size={14} /> Approve
                </button>
                <button className="perm-deny-btn" onClick={() => onResolvePermission(p.toolCallId, 'denied')}>
                  <X size={14} /> Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="agent-sections-grid">
        {/* Permission Mode */}
        <div className="agent-card">
          <div className="agent-card-header">
            <Cpu size={18} />
            <div>
              <h3>Permission Mode</h3>
              <p>Controls how the agent handles write/destructive tool calls.</p>
            </div>
          </div>
          <div className="perm-mode-grid">
            {permModes.map(m => (
              <button
                key={m.id}
                className={`perm-mode-btn ${permissionMode === m.id ? 'active' : ''}`}
                onClick={() => onSetPermissionMode(m.id)}
                title={m.desc}
              >
                <span className="perm-mode-label">{m.label}</span>
                <span className="perm-mode-desc">{m.desc}</span>
              </button>
            ))}
          </div>
          <div className="perm-current">
            Current: <strong>{permissionDesc}</strong>
          </div>
        </div>

        {/* Memory */}
        <div className="agent-card">
          <div className="agent-card-header">
            <Database size={18} />
            <div>
              <h3>Agent Memory</h3>
              <p>Facts the agent has learned about this codebase.</p>
            </div>
          </div>

          <div className="memory-add">
            <select value={newMemoryScope} onChange={e => setNewMemoryScope(e.target.value)}>
              <option value="workspace">Workspace</option>
              <option value="global">Global</option>
              <option value="session">Session</option>
            </select>
            <input
              type="text"
              value={newMemory}
              onChange={e => setNewMemory(e.target.value)}
              placeholder="Add a fact (e.g. 'Auth module is in src/auth/')"
              onKeyDown={e => {
                if (e.key === 'Enter' && newMemory.trim()) {
                  onAddMemory(newMemory.trim(), newMemoryScope);
                  setNewMemory('');
                }
              }}
            />
            <button
              onClick={() => { if (newMemory.trim()) { onAddMemory(newMemory.trim(), newMemoryScope); setNewMemory(''); } }}
              disabled={!newMemory.trim()}
            >
              <Send size={14} />
            </button>
          </div>

          <div className="memory-list">
            {memoryItems.length === 0 ? (
              <div className="memory-empty">No memories yet. The agent will save facts as it learns them.</div>
            ) : (
              memoryItems.map(m => (
                <div key={m.id} className="memory-item">
                  <div className="memory-item-header">
                    <span className={`memory-scope scope-${m.scope}`}>{m.scope}</span>
                    <span className="memory-id">#{m.id}</span>
                    <button className="memory-delete" onClick={() => onDeleteMemory(m.id)}>
                      <X size={12} />
                    </button>
                  </div>
                  <div className="memory-content">{m.content}</div>
                  {m.tags && m.tags.length > 0 && (
                    <div className="memory-tags">
                      {m.tags.map(t => <span key={t} className="memory-tag">{t}</span>)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          {memoryItems.length > 0 && (
            <button className="memory-clear-btn" onClick={() => { if (confirm('Clear all memory?')) onClearMemory(); }}>
              Clear All
            </button>
          )}
        </div>

        {/* Audit Log */}
        <div className="agent-card agent-card-full">
          <div className="agent-card-header">
            <Terminal size={18} />
            <div>
              <h3>Audit Log</h3>
              <p>Record of every tool call the agent has made (secrets redacted).</p>
            </div>
            <button className="audit-refresh-btn" onClick={onRefresh} title="Refresh">
              <RefreshCw size={14} />
            </button>
          </div>

          <input
            type="text"
            className="audit-filter"
            value={auditFilter}
            onChange={e => setAuditFilter(e.target.value)}
            placeholder="Filter by tool name, question, or permission…"
          />

          <div className="audit-list">
            {filteredAudit.length === 0 ? (
              <div className="audit-empty">No audit entries yet. Tool calls will appear here when the agent runs.</div>
            ) : (
              filteredAudit.slice(0, 50).map(e => (
                <AuditEntryRow key={e.id} entry={e} />
              ))
            )}
          </div>
          {auditEntries.length > 0 && (
            <button className="audit-clear-btn" onClick={() => { if (confirm('Clear audit log?')) onClearAudit(); }}>
              Clear Log
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const permClass = `audit-perm perm-${entry.permission.replace('-', '_')}`;
  return (
    <div className={`audit-row ${entry.success ? 'success' : 'error'}`} onClick={() => setExpanded(e => !e)}>
      <div className="audit-row-header">
        <span className={`audit-status ${entry.success ? 'ok' : 'err'}`}>
          {entry.success ? <Check size={12} /> : <AlertCircle size={12} />}
        </span>
        <span className="audit-tool">{entry.toolName}</span>
        <span className={permClass}>{entry.permission}</span>
        <span className="audit-duration">{entry.durationMs}ms</span>
        <span className="audit-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </div>
      {expanded && (
        <div className="audit-row-details">
          <div className="audit-detail-section">
            <span className="audit-detail-label">Question:</span>
            <span className="audit-detail-value">{entry.question}</span>
          </div>
          {entry.args && (
            <div className="audit-detail-section">
              <span className="audit-detail-label">Arguments:</span>
              <pre className="audit-detail-code">{entry.args}</pre>
            </div>
          )}
          {entry.result && (
            <div className="audit-detail-section">
              <span className="audit-detail-label">Result:</span>
              <pre className="audit-detail-code">{entry.result.slice(0, 500)}</pre>
            </div>
          )}
          {entry.error && (
            <div className="audit-detail-section">
              <span className="audit-detail-label">Error:</span>
              <pre className="audit-detail-code audit-detail-error">{entry.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
