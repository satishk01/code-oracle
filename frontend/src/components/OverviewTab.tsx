import { Box, Layers } from 'lucide-react';
import { KIND_COLORS, KIND_ICONS } from './GraphExplorer';
import type { RepoInfo } from './types';

export function OverviewTab({ stats, patterns, endpoints, repoInfo }: {
  stats: Record<string, number>;
  patterns: any[];
  endpoints: any[];
  repoInfo: RepoInfo | null;
}) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return (
    <div className="tab-content">
      <h1>Codebase Overview</h1>

      {total === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔮</div>
          <h2>No data yet</h2>
          <p>Enter a repository path in the sidebar and click <strong>Re-index</strong> to parse it and build the knowledge graph.</p>
          {repoInfo && !repoInfo.indexed && (
            <p className="empty-hint">This repository hasn't been indexed yet.</p>
          )}
        </div>
      ) : (
        <>
          <div className="stat-grid">
            {Object.entries(stats).map(([kind, count]) => {
              const Icon = KIND_ICONS[kind] || Box;
              return (
                <div key={kind} className="stat-card" style={{ borderLeftColor: KIND_COLORS[kind] || '#6b7280' }}>
                  <div className="stat-header">
                    <Icon size={20} style={{ color: KIND_COLORS[kind] || '#6b7280' }} />
                    <span className="stat-kind">{kind}</span>
                  </div>
                  <div className="stat-value">{count}</div>
                </div>
              );
            })}
          </div>

          {patterns.length > 0 && (
            <section className="overview-section">
              <h2>Detected Architecture Patterns</h2>
              <div className="pattern-grid">
                {patterns.map(p => (
                  <div key={p.id} className="pattern-card">
                    <Layers size={18} className="pattern-icon" />
                    <span>{p.name}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {endpoints.length > 0 && (
            <section className="overview-section">
              <h2>API Endpoints</h2>
              <div className="endpoint-list">
                {endpoints.map(ep => {
                  const meta = JSON.parse(ep.metadata || '{}');
                  return (
                    <div key={ep.id} className="endpoint-row">
                      <span className={`http-method method-${(meta.method || 'GET').toLowerCase()}`}>
                        {meta.method || 'GET'}
                      </span>
                      <code>{meta.path || ep.name}</code>
                      <span className="endpoint-file">{ep.filePath}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
