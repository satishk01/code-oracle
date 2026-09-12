import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Cpu,
  MessageCircle,
  Sparkles,
  Zap,
  Layers,
  FileCode,
  CheckCircle2,
  ListOrdered,
  Flame,
  ArrowRight,
  Download,
  FileText,
  Search,
} from 'lucide-react';
import { api } from '../hooks/useApi';
import { KIND_COLORS } from './GraphExplorer';
import { exportCodeImpact, exportRequirementPlan } from '../utils/impactExporter';

export function ImpactTab({ files, onFilesChange, report, onAnalyze, loading }: any) {
  // Mode selector: 'requirement' (default) vs 'files'
  const [activeMode, setActiveMode] = useState<'requirement' | 'files'>('requirement');

  // LLM toggle state
  const [useLlm, setUseLlm] = useState(false);

  // Requirement state
  const [requirementText, setRequirementText] = useState('');
  const [requirementReport, setRequirementReport] = useState<any>(null);
  const [analyzingRequirement, setAnalyzingRequirement] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);

  // Quick suggestion chips
  const quickRequirements = [
    'If I need to add two more sales related endpoints with drill down options what is the impact',
    'What is the impact if I need to optimize database queries and find performance bottlenecks',
    'Add OAuth2 Google and GitHub login support with JWT validation',
    'Implement rate-limiting and API key authentication middleware',
  ];

  const quickFiles = [
    'src/api/server.ts',
    'src/graph/store.ts',
    'src/parsers/typescript-parser.ts',
    'src/agent/engine.ts',
  ];

  async function handleRequirementAnalysis(textToAnalyze?: string) {
    const text = (textToAnalyze ?? requirementText).trim();
    if (!text) return;
    setAnalyzingRequirement(true);
    setReqError(null);
    try {
      const result = await api.requirementImpact(text, useLlm);
      setRequirementReport(result);
    } catch (err: any) {
      console.error('Requirement analysis failed:', err);
      setReqError(err.message || 'Analysis failed');
    }
    setAnalyzingRequirement(false);
  }

  async function handleCodeAnalyze() {
    const trimmed = files.trim();
    if (!trimmed) return;

    // Smart auto-detection: if the user typed a natural language question or requirement in file mode,
    // seamlessly route it through Requirement Impact so they get a full roadmap & bottleneck analysis!
    const isNaturalLanguage =
      trimmed.includes(' ') &&
      (/\b(what|if|need|add|how|why|when|where|create|implement|endpoint|endpoints|sales|impact|optimize|bottleneck|auth)\b/i.test(trimmed) ||
       !trimmed.includes('.'));

    if (isNaturalLanguage) {
      setRequirementText(trimmed);
      setActiveMode('requirement');
      await handleRequirementAnalysis(trimmed);
    } else {
      onAnalyze(useLlm);
    }
  }

  return (
    <div className="tab-content impact-tab-container">
      <div className="tab-header">
        <h1>Impact Analysis & Implementation Planning</h1>
        <p className="tab-desc">
          Analyze the blast radius of new requirements or modified files.
          Discovers affected endpoints, coupling hotspots, and generates an actionable step-by-step implementation roadmap.
        </p>
      </div>

      {/* ── Mode Switcher Tabs ─────────────────────────────────────────── */}
      <div className="impact-mode-switcher">
        <button
          type="button"
          className={`impact-mode-tab ${activeMode === 'requirement' ? 'active' : ''}`}
          onClick={() => setActiveMode('requirement')}
        >
          <MessageCircle size={17} />
          <span>Requirement & Roadmap Planning</span>
        </button>
        <button
          type="button"
          className={`impact-mode-tab ${activeMode === 'files' ? 'active' : ''}`}
          onClick={() => setActiveMode('files')}
        >
          <FileCode size={17} />
          <span>File-Based Blast Radius</span>
        </button>
      </div>

      {/* ── MODE 1: Requirement & Roadmap Planning (Primary) ─────────── */}
      {activeMode === 'requirement' && (
        <div className="impact-main-panel">
          <div className="impact-card requirement-card">
            <div className="impact-card-header">
              <div className="impact-card-title-group">
                <MessageCircle size={20} className="impact-icon" />
                <div>
                  <h3>Requirement-Based Impact & Implementation Roadmap</h3>
                  <p>Describe a new feature, question, or change to generate an impact blast radius and step-by-step implementation roadmap.</p>
                </div>
              </div>
            </div>

            {/* Quick suggestion chips */}
            <div className="quick-chips-group">
              <span className="quick-chips-label">Try example:</span>
              {quickRequirements.map((qr, i) => (
                <button
                  key={i}
                  type="button"
                  className="quick-chip-btn req-chip"
                  onClick={() => {
                    setRequirementText(qr);
                    handleRequirementAnalysis(qr);
                  }}
                  title={qr}
                >
                  {qr.length > 45 ? `${qr.slice(0, 45)}…` : qr}
                </button>
              ))}
            </div>

            <div className="impact-input">
              <textarea
                value={requirementText}
                onChange={e => setRequirementText(e.target.value)}
                placeholder="e.g. 'If I need to add two more sales related endpoints with drill down options what is the impact and performance bottlenecks'"
                rows={3}
              />

              {/* LLM Toggle */}
              <div className="impact-llm-toggle-wrapper">
                <label className={`impact-llm-toggle-label ${useLlm ? 'active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={useLlm}
                    onChange={e => setUseLlm(e.target.checked)}
                  />
                  <Sparkles size={15} />
                  <span>LLM Deep Planning & Bottleneck Diagnosis</span>
                </label>
              </div>

              <button
                className="primary-btn"
                onClick={() => handleRequirementAnalysis()}
                disabled={analyzingRequirement || !requirementText.trim()}
              >
                <MessageCircle size={16} />
                {analyzingRequirement ? 'Analyzing Requirement & Generating Roadmap…' : 'Analyze Requirement & Generate Plan'}
              </button>
            </div>

            {reqError && (
              <div className="impact-error-banner">
                <AlertTriangle size={16} />
                <span>{reqError}</span>
              </div>
            )}

            {requirementReport && (
              <div className="impact-report">
                {/* Header Badges & Export */}
                <div className="impact-report-header">
                  <div className="impact-header-left">
                    <div className={`risk-badge risk-${requirementReport.riskScore < 25 ? 'low' : requirementReport.riskScore < 50 ? 'med' : requirementReport.riskScore < 75 ? 'high' : 'crit'}`}>
                      <AlertTriangle size={16} />
                      <span>Risk Score: {requirementReport.riskScore}/100</span>
                    </div>

                    {requirementReport.detectedIntents && (
                      <div className="intent-chips-group">
                        {requirementReport.detectedIntents.map((intent: string, i: number) => (
                          <span key={i} className="intent-chip">{intent}</span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="impact-export-actions">
                    <span className="export-label">Export:</span>
                    <button
                      type="button"
                      className="impact-export-btn"
                      onClick={() => exportRequirementPlan(requirementReport, 'md')}
                      title="Export Requirement Roadmap as Markdown (.md)"
                    >
                      <FileText size={13} />
                      <span>.MD</span>
                    </button>
                    <button
                      type="button"
                      className="impact-export-btn"
                      onClick={() => exportRequirementPlan(requirementReport, 'html')}
                      title="Export Requirement Roadmap as standalone HTML (.html)"
                    >
                      <Download size={13} />
                      <span>.HTML</span>
                    </button>
                  </div>
                </div>

                {/* Stats Counters */}
                <div className="impact-stats">
                  <div className="is-item">
                    <strong>{requirementReport.matchedEntities?.length || 0}</strong> Target Components
                  </div>
                  <div className="is-item">
                    <strong>{requirementReport.impactedEntities?.length || 0}</strong> Dependencies
                  </div>
                  <div className="is-item">
                    <strong>{requirementReport.affectedEndpoints?.length || 0}</strong> Endpoints
                  </div>
                  <div className="is-item">
                    <strong>{requirementReport.performanceBottlenecks?.length || 0}</strong> Hotspots
                  </div>
                  <div className="is-item">
                    <strong>{requirementReport.implementationPlan?.length || 0}</strong> Roadmap Steps
                  </div>
                </div>

                {/* ── 1. Step-by-Step Implementation Plan ── */}
                {requirementReport.implementationPlan && requirementReport.implementationPlan.length > 0 && (
                  <section className="impact-section plan-section">
                    <div className="impact-section-title">
                      <ListOrdered size={18} className="text-accent" />
                      <h4>Implementation Roadmap ({requirementReport.implementationPlan.length} Steps)</h4>
                    </div>

                    <div className="plan-steps-timeline">
                      {requirementReport.implementationPlan.map((step: any, i: number) => (
                        <div key={i} className="plan-step-card">
                          <div className="plan-step-header">
                            <span className="plan-step-index">{i + 1}</span>
                            <span className={`plan-action-badge action-${step.action}`}>
                              {step.action?.toUpperCase() || 'ACTION'}
                            </span>
                            <span className="plan-step-title">{step.title}</span>
                          </div>

                          {step.targetFile && (
                            <div className="plan-step-file">
                              <FileCode size={14} />
                              <span>Target File: <code>{step.targetFile}</code></span>
                            </div>
                          )}

                          <p className="plan-step-desc">{step.description}</p>

                          {step.details && step.details.length > 0 && (
                            <ul className="plan-step-details">
                              {step.details.map((detail: string, dIdx: number) => (
                                <li key={dIdx}>{detail}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* ── 2. Performance Bottlenecks & Hotspots ── */}
                {requirementReport.performanceBottlenecks && requirementReport.performanceBottlenecks.length > 0 && (
                  <section className="impact-section bottleneck-section">
                    <div className="impact-section-title">
                      <Flame size={18} className="text-warning" />
                      <h4>Performance Bottlenecks & Coupling Hotspots ({requirementReport.performanceBottlenecks.length})</h4>
                    </div>

                    <div className="bottleneck-cards-grid">
                      {requirementReport.performanceBottlenecks.map((bn: any, i: number) => (
                        <div key={i} className={`bottleneck-card severity-border-${bn.severity}`}>
                          <div className="bn-header">
                            <span className="bn-component"><code>{bn.component}</code></span>
                            <span className={`severity-tag severity-${bn.severity}`}>{bn.severity}</span>
                            <span className="bn-type-badge">{bn.type}</span>
                          </div>
                          <div className="bn-location">{bn.filePath}</div>
                          <div className="bn-metric"><strong>Metric:</strong> {bn.metrics}</div>
                          <div className="bn-risk">{bn.riskExplanation}</div>
                          <div className="bn-rec">
                            <CheckCircle2 size={14} className="text-success" />
                            <span><strong>Recommendation:</strong> {bn.recommendation}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* ── 3. Affected API Endpoints ── */}
                {requirementReport.affectedEndpoints && requirementReport.affectedEndpoints.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <Zap size={16} className="text-accent" />
                      <h4>Existing API Endpoints Touched ({requirementReport.affectedEndpoints.length})</h4>
                    </div>
                    <div className="impact-list">
                      {requirementReport.affectedEndpoints.map((ep: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-method">{ep.name}</span>
                          <span className="ir-path">{ep.filePath}:{ep.startLine}</span>
                          <span className="ir-desc">{ep.description || 'API Endpoint'}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* ── 4. Matched Target Components (Direct Impact) ── */}
                {requirementReport.matchedEntities && requirementReport.matchedEntities.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <Layers size={16} />
                      <h4>Primary Target Components ({requirementReport.matchedEntities.length})</h4>
                    </div>
                    <div className="impact-list">
                      {requirementReport.matchedEntities.slice(0, 15).map((m: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-kind" style={{ color: KIND_COLORS[m.node.kind] }}>{m.node.kind}</span>
                          <span className="ir-name">{m.node.name}</span>
                          <span className="ir-path">{m.node.filePath}:{m.node.startLine}</span>
                          <span className="ir-match-reason">{m.matchReason}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* ── 5. Transitive Dependencies & Callers ── */}
                {requirementReport.impactedEntities && requirementReport.impactedEntities.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <ArrowRight size={16} />
                      <h4>Transitive Blast Radius ({requirementReport.impactedEntities.length})</h4>
                    </div>
                    <div className="impact-list">
                      {requirementReport.impactedEntities.slice(0, 15).map((imp: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-kind" style={{ color: KIND_COLORS[imp.node.kind] }}>{imp.node.kind}</span>
                          <span className="ir-name">{imp.node.name}</span>
                          <span className="ir-reason">{imp.reason}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* ── 6. LLM Deep Enrichment ── */}
                {requirementReport.llmEnrichment && (
                  <section className="impact-section llm-enrichment-card">
                    <div className="impact-section-title">
                      <Sparkles size={18} className="text-accent" />
                      <h4>LLM Deep Architectural Analysis</h4>
                    </div>

                    <div className="llm-explanation-text">
                      <p>{requirementReport.llmEnrichment.explanation}</p>
                    </div>

                    {requirementReport.llmEnrichment.bottleneckAnalysis && (
                      <div className="llm-bottleneck-box">
                        <h5>⚡ Deep Bottleneck Diagnosis</h5>
                        <p>{requirementReport.llmEnrichment.bottleneckAnalysis}</p>
                      </div>
                    )}

                    {requirementReport.llmEnrichment.severityAssessments?.length > 0 && (
                      <div className="severity-table-wrapper">
                        <h5>Component Severity Breakdown</h5>
                        <table className="severity-table">
                          <thead>
                            <tr>
                              <th>Component</th>
                              <th>Severity</th>
                              <th>Assessment</th>
                            </tr>
                          </thead>
                          <tbody>
                            {requirementReport.llmEnrichment.severityAssessments.map((sa: any, i: number) => (
                              <tr key={i}>
                                <td><code>{sa.name}</code></td>
                                <td>
                                  <span className={`severity-tag severity-${sa.severity}`}>
                                    {sa.severity}
                                  </span>
                                </td>
                                <td>{sa.reasoning}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {requirementReport.llmEnrichment.testSuggestions?.length > 0 && (
                      <div className="test-suggestions-box">
                        <h5>Verification & Test Strategy</h5>
                        <ul>
                          {requirementReport.llmEnrichment.testSuggestions.map((ts: string, i: number) => (
                            <li key={i}>{ts}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── MODE 2: File-Based Blast Radius ───────────────────────────── */}
      {activeMode === 'files' && (
        <div className="impact-main-panel">
          <div className="impact-card">
            <div className="impact-card-header">
              <div className="impact-card-title-group">
                <FileCode size={20} className="impact-icon" />
                <div>
                  <h3>File-Based Blast Radius</h3>
                  <p>Specify modified file paths to calculate direct dependents, transitive callers, and affected endpoints.</p>
                </div>
              </div>
            </div>

            {/* Quick file chips */}
            <div className="quick-chips-group">
              <span className="quick-chips-label">Quick insert:</span>
              {quickFiles.map((qf, i) => (
                <button
                  key={i}
                  type="button"
                  className="quick-chip-btn"
                  onClick={() => onFilesChange(files ? `${files}\n${qf}` : qf)}
                  title={`Add ${qf}`}
                >
                  + {qf.split('/').pop()}
                </button>
              ))}
            </div>

            <div className="impact-input">
              <textarea
                value={files}
                onChange={e => onFilesChange(e.target.value)}
                placeholder={'src/api/server.ts\nsrc/graph/store.ts'}
                rows={3}
              />

              {/* LLM Toggle */}
              <div className="impact-llm-toggle-wrapper">
                <label className={`impact-llm-toggle-label ${useLlm ? 'active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={useLlm}
                    onChange={e => setUseLlm(e.target.checked)}
                  />
                  <Sparkles size={15} />
                  <span>LLM Narrative & Severity Assessment</span>
                </label>
              </div>

              <button className="primary-btn" onClick={handleCodeAnalyze} disabled={loading || !files.trim()}>
                <Activity size={16} />
                {loading ? 'Analyzing Blast Radius…' : 'Analyze Code Impact'}
              </button>
            </div>

            {report && (
              <div className="impact-report">
                <div className="impact-report-header">
                  <div className="impact-header-left">
                    <div className={`risk-badge risk-${report.riskScore < 25 ? 'low' : report.riskScore < 50 ? 'med' : report.riskScore < 75 ? 'high' : 'crit'}`}>
                      <AlertTriangle size={16} />
                      <span>Risk Score: {report.riskScore}/100</span>
                    </div>
                  </div>

                  <div className="impact-export-actions">
                    <span className="export-label">Export:</span>
                    <button
                      type="button"
                      className="impact-export-btn"
                      onClick={() => exportCodeImpact(report, files, 'md')}
                      title="Export Code Impact as Markdown (.md)"
                    >
                      <FileText size={13} />
                      <span>.MD</span>
                    </button>
                    <button
                      type="button"
                      className="impact-export-btn"
                      onClick={() => exportCodeImpact(report, files, 'html')}
                      title="Export Code Impact as standalone HTML (.html)"
                    >
                      <Download size={13} />
                      <span>.HTML</span>
                    </button>
                  </div>
                </div>

                <div className="impact-stats">
                  <div className="is-item"><strong>{report.directImpacts?.length || 0}</strong> Direct Impacts</div>
                  <div className="is-item"><strong>{report.transitiveImpacts?.length || 0}</strong> Transitive Impacts</div>
                  <div className="is-item"><strong>{report.affectedEndpoints?.length || 0}</strong> Endpoints</div>
                  <div className="is-item"><strong>{report.affectedPatterns?.length || 0}</strong> Patterns</div>
                </div>

                {/* Affected Endpoints */}
                {report.affectedEndpoints && report.affectedEndpoints.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <Zap size={16} className="text-warning" />
                      <h4>Affected API Endpoints ({report.affectedEndpoints.length})</h4>
                    </div>
                    <div className="impact-list">
                      {report.affectedEndpoints.map((ep: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-method">{ep.node.name}</span>
                          <span className="ir-path">{ep.node.filePath}:{ep.node.startLine}</span>
                          <span className="ir-score">{(ep.impactScore * 100).toFixed(0)}% risk</span>
                          <span className="ir-reason">{ep.reason}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Direct Impacts */}
                {report.directImpacts && report.directImpacts.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <Layers size={16} />
                      <h4>Directly Impacted Components ({report.directImpacts.length})</h4>
                    </div>
                    <div className="impact-list">
                      {report.directImpacts.slice(0, 20).map((d: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-kind" style={{ color: KIND_COLORS[d.node.kind] }}>{d.node.kind}</span>
                          <span className="ir-name">{d.node.name}</span>
                          <span className="ir-path">{d.node.filePath}:{d.node.startLine}</span>
                          <span className="ir-score">{(d.impactScore * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Transitive Impacts */}
                {report.transitiveImpacts && report.transitiveImpacts.length > 0 && (
                  <section className="impact-section">
                    <div className="impact-section-title">
                      <ArrowRight size={16} />
                      <h4>Transitive Callers & Dependencies ({report.transitiveImpacts.length})</h4>
                    </div>
                    <div className="impact-list">
                      {report.transitiveImpacts.slice(0, 20).map((t: any, i: number) => (
                        <div key={i} className="impact-row">
                          <span className="ir-kind" style={{ color: KIND_COLORS[t.node.kind] }}>{t.node.kind}</span>
                          <span className="ir-name">{t.node.name}</span>
                          <span className="ir-reason">{t.reason}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* LLM Enrichment */}
                {report.llmEnrichment && (
                  <section className="impact-section llm-enrichment-card">
                    <div className="impact-section-title">
                      <Sparkles size={16} className="text-accent" />
                      <h4>LLM Architectural Assessment</h4>
                    </div>
                    <div className="llm-explanation-text">
                      <p>{report.llmEnrichment.explanation}</p>
                    </div>

                    {report.llmEnrichment.severityAssessments?.length > 0 && (
                      <div className="severity-table-wrapper">
                        <h5>Severity Breakdown</h5>
                        <table className="severity-table">
                          <thead>
                            <tr>
                              <th>Component</th>
                              <th>Severity</th>
                              <th>Rationale</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.llmEnrichment.severityAssessments.map((sa: any, i: number) => (
                              <tr key={i}>
                                <td><code>{sa.name}</code></td>
                                <td>
                                  <span className={`severity-tag severity-${sa.severity}`}>
                                    {sa.severity}
                                  </span>
                                </td>
                                <td>{sa.reasoning}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {report.llmEnrichment.testSuggestions?.length > 0 && (
                      <div className="test-suggestions-box">
                        <h5>Recommended Verification & Tests</h5>
                        <ul>
                          {report.llmEnrichment.testSuggestions.map((ts: string, i: number) => (
                            <li key={i}>{ts}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
