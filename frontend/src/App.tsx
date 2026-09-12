import { useState, useEffect, useRef } from 'react';
import {
  MessageCircle, Activity, GitBranch, Layers,
  RefreshCw, ChevronRight,
  Cpu, Database, X, FolderOpen, AlertCircle, FileText,
  Network, Bot,
} from 'lucide-react';
import { api, RepoInfo, RepoEntry } from './hooks/useApi';
import type { AgentStreamEvent, MemoryItem, AuditEntry } from './hooks/useApi';
import { GraphExplorer } from './components/GraphExplorer';
import { MindmapTab } from './components/MindmapTab';
import { OverviewTab } from './components/OverviewTab';
import { ImpactTab } from './components/ImpactTab';
import { AskTab } from './components/AskTab';
import { DocsTab } from './components/DocsTab';
import { AgentTab } from './components/AgentTab';
import { FolderPicker } from './components/FolderPicker';
import type { GraphNode, GraphEdge, ToolActivity, QaExchange, PendingPermission } from './components/types';
import './styles/app.css';

// ── Tab type ─────────────────────────────────────────────────────
type Tab = 'overview' | 'graph' | 'mindmap' | 'impact' | 'ask' | 'docs' | 'agent';

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(false);
  const [repoRoot, setRepoRoot] = useState('');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [repoInput, setRepoInput] = useState('');
  const [repoList, setRepoList] = useState<RepoEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<string | null>(null);

  // Overview state
  const [stats, setStats] = useState<Record<string, number>>({});
  const [patterns, setPatterns] = useState<any[]>([]);
  const [endpoints, setEndpoints] = useState<any[]>([]);

  // Graph state
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [neighborhood, setNeighborhood] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('all');

  // Impact state
  const [impactFiles, setImpactFiles] = useState('');
  const [impactReport, setImpactReport] = useState<any>(null);

  // Q&A state
  const [question, setQuestion] = useState('');
  const [qaHistory, setQaHistory] = useState<QaExchange[]>([]);
  const [answering, setAnswering] = useState(false);
  const [agenticMode, setAgenticMode] = useState(true); // agentic streaming by default
  const [streamingAnswer, setStreamingAnswer] = useState<string>('');
  const [streamingTools, setStreamingTools] = useState<ToolActivity[]>([]);
  const [streamingStatus, setStreamingStatus] = useState<string>('');
  const [streamingError, setStreamingError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Docs state
  const [docFormat, setDocFormat] = useState<'md' | 'html'>('md');
  const [docPreview, setDocPreview] = useState<string | null>(null);
  const [docFilename, setDocFilename] = useState<string>('');
  const [generating, setGenerating] = useState(false);

  // Folder picker state
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // LLM enrichment toggle
  const [useLlmEnrichment, setUseLlmEnrichment] = useState(false);

  // Phase 3: Agent tab state
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [permissionMode, setPermissionMode] = useState<string>('interactive');
  const [permissionDesc, setPermissionDesc] = useState<string>('');
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [compactionNotices, setCompactionNotices] = useState<string[]>([]);

  // ── Load on mount ──────────────────────────────────────────────
  useEffect(() => {
    api.health().then(h => {
      setRepoRoot(h.repoRoot);
      setRepoInput(h.repoRoot);
    }).catch(() => {});
    loadRepoInfo();
    loadRepoList();
    loadOverview();
    loadAgentTab();
  }, []);

  // ── Phase 3: Load agent tab data ────────────────────────────────
  async function loadAgentTab() {
    try {
      const [mem, aud, perm] = await Promise.all([
        api.listMemory(),
        api.listAudit(),
        api.getPermissionMode(),
      ]);
      setMemoryItems(mem.items);
      setAuditEntries(aud.entries);
      setPermissionMode(perm.mode);
      setPermissionDesc(perm.description);
    } catch (err: any) {
      // Non-critical — agent tab may not be available
    }
  }

  async function loadRepoInfo() {
    try {
      const info = await api.getRepo();
      setRepoInfo(info);
      setRepoRoot(info.repoRoot);
      setRepoInput(info.repoRoot);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadRepoList() {
    try {
      const data = await api.listRepos();
      setRepoList(data.repos);
    } catch {
      // Non-critical
    }
  }

  async function loadOverview() {
    try {
      const data = await api.getStats();
      setStats(data.stats);
      setPatterns(data.patterns);
      setEndpoints(data.endpoints);
    } catch (err: any) {
      // Don't overwrite a more important error
      if (!error) setError(`Failed to load overview: ${err.message}`);
    }
  }

  async function loadGraph() {
    setLoading(true);
    try {
      const data = await api.getGraph();
      setGraphNodes(data.nodes);
      setGraphEdges(data.edges);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleSetRepo() {
    const trimmed = repoInput.trim();
    if (!trimmed) return;
    await switchToRepo(trimmed);
  }

  async function switchToRepo(repoPath: string) {
    setLoading(true);
    setError(null);
    setIngestResult(null);
    try {
      const info = await api.setRepo(repoPath);
      setRepoInfo(info);
      setRepoRoot(info.repoRoot);
      setRepoInput(info.repoRoot);
      // Reset all data views
      setStats({});
      setPatterns([]);
      setEndpoints([]);
      setGraphNodes([]);
      setGraphEdges([]);
      setSelectedNode(null);
      setNeighborhood(null);
      setImpactReport(null);
      setQaHistory([]);
      setDocPreview(null);
      // Load whatever is already indexed
      await loadOverview();
      await loadRepoList();
      // Reload the currently-active tab's data for the new repo
      await reloadCurrentTab();
      if (info.indexed && info.nodeCount > 0) {
        setIngestResult(`Already indexed: ${info.nodeCount} nodes, ${info.edgeCount} edges`);
      } else {
        setIngestResult('Not indexed yet — click Re-index to parse this repository.');
      }
    } catch (err: any) {
      setError(err.message);
      setRepoInput(repoRoot);
    }
    setLoading(false);
  }

  /** Reload the data for whichever tab is currently active. */
  async function reloadCurrentTab() {
    switch (tab) {
      case 'graph':
      case 'mindmap':
        await loadGraph();
        break;
      case 'overview':
        await loadOverview();
        break;
      case 'agent':
        await loadAgentTab();
        break;
      // impact, ask, docs don't have persistent server-side data to reload —
      // their state was already cleared above and they fetch on user action.
    }
  }

  async function handleIngest(full = false) {
    setLoading(true);
    setError(null);
    setIngestResult(null);
    try {
      // Use the path the user typed (repoInput) — this ensures we index
      // what's in the text box, not whatever the backend currently has active.
      const targetRepo = repoInput.trim() || repoRoot;
      const result = await api.ingest({ full, repoRoot: targetRepo, useLlmEnrichment });
      const msg = `Indexed ${result.filesProcessed} files → ${result.nodesCreated} nodes, ${result.edgesCreated} edges`;
      setIngestResult(msg);
      await loadRepoInfo();
      await loadRepoList();
      await loadOverview();
      await reloadCurrentTab();
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleSearch(q: string) {
    setSearchQuery(q);
    if (q.length < 2) { setSearchResults([]); return; }
    try {
      const data = await api.search(q);
      setSearchResults(data.results);
    } catch {}
  }

  async function selectNode(node: GraphNode) {
    setSelectedNode(node);
    try {
      const data = await api.getNode(node.id);
      setNeighborhood(data.neighborhood);
    } catch {}
  }

  async function handleImpact(useLlm?: boolean) {
    if (!impactFiles.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const changes = impactFiles.split('\n').filter(f => f.trim()).map(f => ({
        filePath: f.trim(), type: 'modified',
      }));
      const report = await api.impact(changes, useLlm ?? useLlmEnrichment);
      setImpactReport(report);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleAsk() {
    if (!question.trim()) return;
    const currentQuestion = question.trim();
    setAnswering(true);
    setError(null);

    if (agenticMode) {
      // ── Agentic streaming path ──────────────────────────────────
      setStreamingAnswer('');
      setStreamingTools([]);
      setStreamingStatus('Thinking…');
      setStreamingError(null);

      const abort = new AbortController();
      abortRef.current = abort;

      let answerText = '';
      let tools: ToolActivity[] = [];
      let iterations = 0;
      let toolCallsMade = 0;
      let fallback = false;

      try {
        await api.askStream(
          currentQuestion,
          (event: AgentStreamEvent) => {
            switch (event.type) {
              case 'turn_start':
                setStreamingStatus(`Agent: ${event.agent || 'codebase-analyst'}`);
                break;
              case 'assistant_delta':
                if (event.delta) {
                  answerText += event.delta;
                  setStreamingAnswer(answerText);
                  setStreamingStatus(`Generating response… (iteration ${event.iteration ?? 0})`);
                }
                break;
              case 'tool_proposed':
                if (event.toolCalls) {
                  for (const tc of event.toolCalls) {
                    const activity: ToolActivity = {
                      id: tc.id,
                      name: tc.function.name,
                      args: tc.function.arguments,
                      status: 'running',
                    };
                    tools = [...tools, activity];
                    setStreamingTools([...tools]);
                  }
                  setStreamingStatus(`Calling tools: ${event.toolCalls.map(tc => tc.function.name).join(', ')}`);
                }
                break;
              case 'tool_finished':
                if (event.toolCallId) {
                  tools = tools.map(t =>
                    t.id === event.toolCallId
                      ? {
                          ...t,
                          status: event.success ? 'done' : 'error',
                          result: event.result,
                          error: event.error,
                          durationMs: event.durationMs,
                        }
                      : t
                  );
                  setStreamingTools([...tools]);
                  toolCallsMade++;
                }
                break;
              case 'turn_end':
                answerText = event.answer || answerText;
                iterations = event.iterations ?? 0;
                fallback = event.fallback ?? false;
                setStreamingAnswer(answerText);
                setStreamingStatus('');
                break;
              case 'error':
                setStreamingError(event.message || 'Unknown error');
                setStreamingStatus('Error');
                break;
              case 'max_iterations':
                setStreamingStatus(`Reached max iterations (${event.limit})`);
                break;
              case 'permission_required':
                setPendingPermissions(prev => [...prev, {
                  toolCallId: event.toolCallId!,
                  toolName: event.toolName!,
                  riskLevel: event.riskLevel!,
                  args: event.args!,
                  reason: event.reason!,
                }]);
                setStreamingStatus(`⏸ Permission required: ${event.toolName}`);
                break;
              case 'permission_decision':
                setPendingPermissions(prev => prev.filter(p => p.toolCallId !== event.toolCallId));
                if (event.decision === 'approved') {
                  setStreamingStatus(`Permission approved: ${event.toolName}`);
                } else {
                  setStreamingStatus(`Permission denied: ${event.toolName}`);
                }
                break;
              case 'compaction':
                setCompactionNotices(prev => [...prev,
                  `Context compacted: ${event.messagesRemoved} messages summarized, ~${event.tokensSaved} tokens saved.`
                ]);
                break;
              case 'memory_saved':
                // Refresh memory list when a new item is saved
                api.listMemory().then(m => setMemoryItems(m.items)).catch(() => {});
                break;
            }
          },
          abort.signal,
        );

        // Add to history
        const model = fallback ? 'single-shot' : 'agentic';
        setQaHistory(prev => [...prev, {
          q: currentQuestion,
          a: answerText || (streamingError ? `Error: ${streamingError}` : 'No response.'),
          model,
          tools: tools.length > 0 ? tools : undefined,
          iterations,
          fallback,
        }]);
        setQuestion('');
      } catch (err: any) {
        if (err.name === 'AbortError') {
          // User cancelled — add partial result to history
          if (answerText) {
            setQaHistory(prev => [...prev, {
              q: currentQuestion,
              a: answerText + '\n\n*(cancelled by user)*',
              model: 'agentic (cancelled)',
              tools: tools.length > 0 ? tools : undefined,
            }]);
          }
        } else {
          setError(err.message);
        }
      } finally {
        setStreamingAnswer('');
        setStreamingTools([]);
        setStreamingStatus('');
        setStreamingError(null);
        abortRef.current = null;
      }
    } else {
      // ── Legacy single-shot path ─────────────────────────────────
      try {
        const result = await api.ask(currentQuestion);
        setQaHistory(prev => [...prev, { q: currentQuestion, a: result.answer, model: result.model }]);
        setQuestion('');
      } catch (err: any) {
        setError(err.message);
      }
    }
    setAnswering(false);
  }

  function handleStopAsk() {
    abortRef.current?.abort();
  }

  async function handlePreviewDocs(categories?: string[], includeLlmSummary?: boolean) {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.previewDocs(docFormat, categories, includeLlmSummary);
      setDocPreview(result.content);
      setDocFilename(result.filename);
    } catch (err: any) {
      setError(err.message);
    }
    setGenerating(false);
  }

  function handleDownloadDocs(categories?: string[], includeLlmSummary?: boolean) {
    api.downloadDocs(docFormat, categories, includeLlmSummary);
  }

  async function handleClearData(repoPath: string) {
    if (!confirm(`Remove all indexed data for "${repoPath}"?\n\nThis will delete the repo's index data and remove it from the registry. This cannot be undone.`)) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.removeRepo(repoPath, true);
      setIngestResult(`Cleared indexed data for ${repoPath}`);

      // If the server switched to a different repo, update the UI
      if (result.switchedTo && result.switchedTo !== repoRoot) {
        setRepoRoot(result.switchedTo);
        setRepoInput(result.switchedTo);
      }

      await loadRepoList();

      // Reset all data views for the new repo
      setGraphNodes([]);
      setGraphEdges([]);
      setQaHistory([]);
      setDocPreview(null);
      setSelectedNode(null);
      setNeighborhood(null);
      setImpactReport(null);

      // Reload everything for the active repo (may be a new one)
      await loadRepoInfo();
      await loadOverview();
      await loadAgentTab();
      await reloadCurrentTab();
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  // ── Filtered graph ─────────────────────────────────────────────
  const filteredNodes = kindFilter === 'all'
    ? graphNodes
    : graphNodes.filter(n => n.kind === kindFilter);
  const filteredIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = graphEdges.filter(
    e => filteredIds.has(e.fromId) && filteredIds.has(e.toId)
  );

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="logo">
          <span className="logo-icon">🔮</span>
          <span className="logo-text">Codebase<br/>Oracle</span>
        </div>
        <div className="nav-items">
          {([
            ['overview', Layers, 'Overview'],
            ['graph', GitBranch, 'Graph Explorer'],
            ['mindmap', Network, 'Mindmap'],
            ['impact', Activity, 'Impact Analysis'],
            ['ask', MessageCircle, 'Ask Questions'],
            ['docs', FileText, 'Documentation'],
            ['agent', Bot, 'Agent'],
          ] as [Tab, any, string][]).map(([key, Icon, label]) => (
            <button
              key={key}
              className={`nav-btn ${tab === key ? 'active' : ''}`}
              onClick={() => {
                setTab(key);
                if ((key === 'graph' || key === 'mindmap') && graphNodes.length === 0) loadGraph();
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Indexed repos list */}
        <div className="repo-list-section">
          <div className="repo-list-header">
            <Database size={14} />
            <span>Indexed Repos</span>
          </div>
          <div className="repo-list">
            {repoList.length === 0 && (
              <div className="repo-list-empty">No repos indexed yet</div>
            )}
            {repoList.map(r => (
              <div
                key={r.path}
                className={`repo-list-item ${r.path === repoRoot ? 'active' : ''}`}
                onClick={() => !loading && switchToRepo(r.path)}
                title={r.path}
              >
                <div className="repo-list-row">
                  <span className="repo-list-name">{r.name}</span>
                  <button
                    className="repo-list-delete"
                    onClick={(e) => { e.stopPropagation(); handleClearData(r.path); }}
                    disabled={loading}
                    title="Remove indexed data"
                  >
                    <X size={12} />
                  </button>
                </div>
                {r.lastIndexed ? (
                  <span className="repo-list-stats">{r.nodeCount}n · {r.edgeCount}e</span>
                ) : (
                  <span className="repo-list-stats not-indexed">not indexed</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="nav-footer">
          {/* Repo folder selector */}
          <label className="repo-label">
            <FolderOpen size={14} />
            <span>Repository</span>
          </label>
          <div className="repo-input-row">
            <input
              className="repo-input"
              type="text"
              value={repoInput}
              onChange={e => setRepoInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSetRepo()}
              placeholder="C:\path\to\repo"
              title="Enter the absolute path to the repository you want to analyze"
            />
            <button
              className="repo-browse-btn"
              onClick={() => setShowFolderPicker(true)}
              title="Browse for folder"
            >
              <FolderOpen size={14} />
            </button>
            <button
              className="repo-set-btn"
              onClick={handleSetRepo}
              disabled={loading || !repoInput.trim() || repoInput.trim() === repoRoot}
              title="Switch to this repository"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Indexed status badge */}
          {repoInfo && (
            <div className={`indexed-badge ${repoInfo.indexed && repoInfo.nodeCount > 0 ? 'indexed' : 'not-indexed'}`}>
              {repoInfo.indexed && repoInfo.nodeCount > 0 ? (
                <>✓ {repoInfo.nodeCount} nodes · {repoInfo.edgeCount} edges</>
              ) : (
                <>○ Not indexed</>
              )}
            </div>
          )}

          <button className="ingest-btn" onClick={() => handleIngest()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? 'Indexing…' : 'Re-index'}
          </button>
          <button
            className="ingest-btn full-ingest-btn"
            onClick={() => handleIngest(true)}
            disabled={loading}
            title="Force full re-ingestion (ignore cache)"
          >
            <Database size={16} />
            Full Re-index
          </button>

          {/* LLM enrichment toggle */}
          <label className="llm-toggle" title="Use LLM to generate node descriptions and validate architecture patterns during indexing">
            <input
              type="checkbox"
              checked={useLlmEnrichment}
              onChange={e => setUseLlmEnrichment(e.target.checked)}
            />
            <Cpu size={14} />
            <span>LLM Enrichment</span>
          </label>

          {/* Status messages */}
          {ingestResult && !error && (
            <div className="status-msg status-ok">{ingestResult}</div>
          )}
          {error && (
            <div className="status-msg status-err" onClick={() => setError(null)}>
              <AlertCircle size={14} />
              <span>{error}</span>
              <X size={12} className="dismiss-btn" />
            </div>
          )}
        </div>
      </nav>

      {/* Main content */}
      <main className="content">
        {tab === 'overview' && (
          <OverviewTab stats={stats} patterns={patterns} endpoints={endpoints} repoInfo={repoInfo} />
        )}
        {tab === 'graph' && (
          <GraphExplorer
            nodes={filteredNodes}
            edges={filteredEdges}
            allNodes={graphNodes}
            selectedNode={selectedNode}
            neighborhood={neighborhood}
            onSelectNode={selectNode}
            onCloseNode={() => { setSelectedNode(null); setNeighborhood(null); }}
            searchQuery={searchQuery}
            searchResults={searchResults}
            onSearch={handleSearch}
            kindFilter={kindFilter}
            onKindFilter={setKindFilter}
            onNavigateToImpact={(filePath) => {
              setImpactFiles(filePath);
              setTab('impact');
            }}
            onNavigateToMindmap={() => {
              setTab('mindmap');
            }}
          />
        )}
        {tab === 'mindmap' && (
          <MindmapTab
            nodes={graphNodes}
            edges={graphEdges}
            repoName={repoRoot.split(/[\/\\]/).pop() || 'Repository'}
            repoRoot={repoRoot}
            onSelectGraphNode={selectNode}
            onNavigateToImpact={(filePath) => {
              setImpactFiles(filePath);
              setTab('impact');
            }}
            onNavigateToGraph={() => {
              setTab('graph');
            }}
          />
        )}
        {tab === 'impact' && (
          <ImpactTab
            files={impactFiles}
            onFilesChange={setImpactFiles}
            report={impactReport}
            onAnalyze={handleImpact}
            loading={loading}
          />
        )}
        {tab === 'ask' && (
          <AskTab
            question={question}
            onQuestionChange={setQuestion}
            history={qaHistory}
            onAsk={handleAsk}
            onStop={handleStopAsk}
            answering={answering}
            agenticMode={agenticMode}
            onToggleMode={() => setAgenticMode(m => !m)}
            streamingAnswer={streamingAnswer}
            streamingTools={streamingTools}
            streamingStatus={streamingStatus}
            streamingError={streamingError}
          />
        )}
        {tab === 'docs' && (
          <DocsTab
            format={docFormat}
            onFormatChange={setDocFormat}
            preview={docPreview}
            filename={docFilename}
            generating={generating}
            onPreview={handlePreviewDocs}
            onDownload={handleDownloadDocs}
            repoInfo={repoInfo}
          />
        )}
        {tab === 'agent' && (
          <AgentTab
            memoryItems={memoryItems}
            auditEntries={auditEntries}
            permissionMode={permissionMode}
            permissionDesc={permissionDesc}
            pendingPermissions={pendingPermissions}
            compactionNotices={compactionNotices}
            onRefresh={loadAgentTab}
            onAddMemory={async (content, scope) => {
              try { await api.addMemory(content, scope); await loadAgentTab(); } catch (e: any) { setError(e.message); }
            }}
            onDeleteMemory={async (id) => {
              try { await api.deleteMemory(id); await loadAgentTab(); } catch (e: any) { setError(e.message); }
            }}
            onClearMemory={async () => {
              try { await api.clearMemory(); await loadAgentTab(); } catch (e: any) { setError(e.message); }
            }}
            onSetPermissionMode={async (mode) => {
              try { const r = await api.setPermissionMode(mode); setPermissionMode(r.mode); setPermissionDesc(r.description); } catch (e: any) { setError(e.message); }
            }}
            onClearAudit={async () => {
              try { await api.clearAudit(); await loadAgentTab(); } catch (e: any) { setError(e.message); }
            }}
            onResolvePermission={async (toolCallId, decision) => {
              // Note: engineId would need to be tracked from the streaming request
              // For now, we use a placeholder — the server matches by toolCallId
              try { await api.resolvePermission('active', toolCallId, decision); } catch (e: any) { setError(e.message); }
            }}
            onDismissNotice={(idx) => setCompactionNotices(prev => prev.filter((_, i) => i !== idx))}
          />
        )}
      </main>

      {/* Folder picker modal */}
      {showFolderPicker && (
        <FolderPicker
          initialPath={repoRoot || undefined}
          onSelect={(p) => {
            setRepoInput(p);
            setShowFolderPicker(false);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}
    </div>
  );
}
