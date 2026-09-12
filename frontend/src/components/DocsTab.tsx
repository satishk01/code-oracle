import { useState } from 'react';
import { AlertTriangle, FileText, Eye, Download, Sparkles } from 'lucide-react';

export function DocsTab({ format, onFormatChange, preview, filename, generating,
  onPreview, onDownload, repoInfo }: any) {

  const notIndexed = repoInfo && (!repoInfo.indexed || repoInfo.nodeCount === 0);

  // Documentation categories state
  const [selectedCategories, setSelectedCategories] = useState<string[]>([
    'business', 'architecture', 'api', 'technical', 'developer'
  ]);

  // LLM enrichment toggle
  const [includeLlmSummary, setIncludeLlmSummary] = useState(false);

  const categories = [
    { id: 'business', label: 'Business & Functional', desc: 'Business domains, user workflows, entry points, README content, and system touchpoints' },
    { id: 'architecture', label: 'Architecture & Design', desc: 'Layered architecture, call-graph hotspots, Mermaid diagrams, patterns, and deployment view' },
    { id: 'api', label: 'API & Routes', desc: 'Endpoints grouped by module/router, with handler cross-references and per-endpoint detail cards' },
    { id: 'technical', label: 'Technical Code Reference', desc: 'Classes, interfaces, functions, types with signatures, relationships, and source snippets' },
    { id: 'developer', label: 'Developer Guide & Setup', desc: 'Prerequisites, step-by-step setup, env vars, commands, project structure, and troubleshooting' },
  ];

  const toggleCategory = (id: string) => {
    setSelectedCategories(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    );
  };

  const handlePreviewWithCats = () => onPreview(selectedCategories, includeLlmSummary);
  const handleDownloadWithCats = () => onDownload(selectedCategories, includeLlmSummary);

  return (
    <div className="tab-content docs-tab">
      <h1>Generate Documentation</h1>
      <p className="tab-desc">
        Generate a production-ready, multi-dimensional developer and business knowledge-base document
        from the knowledge graph and live filesystem. Select categories, choose the format, and preview or download.
      </p>

      {notIndexed && (
        <div className="docs-warning">
          <AlertTriangle size={18} />
          <span>This repository hasn't been indexed yet. Click <strong>Re-index</strong> in the sidebar first.</span>
        </div>
      )}

      {/* Documentation Categories Selection */}
      <div className="docs-categories-section">
        <label className="docs-section-label">Select categories to include:</label>
        <div className="docs-categories-grid">
          {categories.map(cat => (
            <label key={cat.id} className={`docs-category-card ${selectedCategories.includes(cat.id) ? 'selected' : ''}`}>
              <input
                type="checkbox"
                checked={selectedCategories.includes(cat.id)}
                onChange={() => toggleCategory(cat.id)}
              />
              <div className="category-info">
                <span className="category-label">{cat.label}</span>
                <span className="category-desc">{cat.desc}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* LLM enrichment toggle */}
      <div className="docs-llm-toggle-section">
        <label className={`docs-llm-toggle ${includeLlmSummary ? 'active' : ''}`}>
          <input
            type="checkbox"
            checked={includeLlmSummary}
            onChange={(e) => setIncludeLlmSummary(e.target.checked)}
          />
          <Sparkles size={16} />
          <div className="llm-toggle-info">
            <span className="llm-toggle-label">LLM Narrative Enrichment</span>
            <span className="llm-toggle-desc">
              Use the configured LLM to generate an executive summary, per-domain workflow narratives,
              and endpoint descriptions. Requires a running provider (Ollama/Omniroute/Bedrock). Slower but richer.
            </span>
          </div>
        </label>
      </div>

      {/* Format selector */}
      <div className="docs-controls">
        <div className="docs-format-group">
          <label className="docs-format-label">Output format:</label>
          <div className="docs-format-options">
            <button
              className={`docs-format-btn ${format === 'md' ? 'active' : ''}`}
              onClick={() => onFormatChange('md')}
            >
              <FileText size={16} />
              Markdown (.md)
            </button>
            <button
              className={`docs-format-btn ${format === 'html' ? 'active' : ''}`}
              onClick={() => onFormatChange('html')}
            >
              <FileText size={16} />
              HTML (.html)
            </button>
          </div>
        </div>

        <div className="docs-actions">
          <button
            className="primary-btn"
            onClick={handlePreviewWithCats}
            disabled={generating || notIndexed || selectedCategories.length === 0}
          >
            <Eye size={16} />
            {generating ? 'Generating…' : 'Preview'}
          </button>
          <button
            className="primary-btn"
            onClick={handleDownloadWithCats}
            disabled={notIndexed || selectedCategories.length === 0}
            title="Download the document file"
          >
            <Download size={16} />
            Download {format.toUpperCase()}
          </button>
        </div>
      </div>

      {/* Preview area */}
      {preview && (
        <div className="docs-preview">
          <div className="docs-preview-header">
            <span className="docs-preview-filename">{filename}</span>
            <span className="docs-preview-size">{(preview.length / 1024).toFixed(1)} KB</span>
          </div>
          {format === 'html' ? (
            <iframe
              className="docs-html-preview"
              srcDoc={preview}
              title="Document Preview"
            />
          ) : (
            <pre className="docs-md-preview">{preview}</pre>
          )}
        </div>
      )}
    </div>
  );
}
