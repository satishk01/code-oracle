import { useState, useEffect, useRef } from 'react';
import {
  Send, ChevronRight, AlertCircle, Loader, Check, Terminal,
  ChevronDown, ChevronUp, Bot, Zap, StopCircle, Wrench, MessageCircle,
} from 'lucide-react';
import type { QaExchange, ToolActivity } from './types';

export function AskTab({
  question, onQuestionChange, history, onAsk, onStop, answering,
  agenticMode, onToggleMode,
  streamingAnswer, streamingTools, streamingStatus, streamingError,
}: {
  question: string;
  onQuestionChange: (s: string) => void;
  history: QaExchange[];
  onAsk: () => void;
  onStop: () => void;
  answering: boolean;
  agenticMode: boolean;
  onToggleMode: () => void;
  streamingAnswer: string;
  streamingTools: ToolActivity[];
  streamingStatus: string;
  streamingError: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, streamingAnswer, streamingTools]);

  const suggestions = [
    'What is this repository for?',
    'What architecture patterns does this codebase use?',
    'List all the API endpoints',
    'What are the main classes and their responsibilities?',
    'Show me the dependency structure',
  ];

  const isStreaming = answering && agenticMode;

  return (
    <div className="tab-content ask-tab">
      <div className="ask-header">
        <h1>Ask about the codebase</h1>
        <button
          className={`mode-toggle ${agenticMode ? 'agentic' : 'legacy'}`}
          onClick={onToggleMode}
          title={agenticMode
            ? 'Agentic mode: iterative tool-using loop with streaming. Click to switch to fast single-shot mode.'
            : 'Fast mode: single-shot Q&A. Click to switch to agentic mode with tool use.'}
        >
          {agenticMode ? <Bot size={16} /> : <Zap size={16} />}
          {agenticMode ? 'Agentic' : 'Fast'}
        </button>
      </div>

      <div className="qa-container">
        <div className="qa-history">
          {history.length === 0 && !isStreaming && (
            <div className="qa-empty">
              {agenticMode ? <Bot size={32} /> : <MessageCircle size={32} />}
              <p>Ask anything about the codebase — architecture, patterns, dependencies, or specific code.
                 {agenticMode && ' The agent will use tools to query the graph, read files, and analyze impact.'}
              </p>
              <div className="qa-suggestions">
                {suggestions.map(s => (
                  <button key={s} onClick={() => { onQuestionChange(s); setTimeout(onAsk, 0); }}>
                    <ChevronRight size={14} />{s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {history.map((h, i: number) => (
            <div key={i} className="qa-exchange">
              <div className="qa-question"><strong>Q:</strong> {h.q}</div>
              <div className="qa-answer">
                {h.tools && h.tools.length > 0 && (
                  <details className="qa-tools-summary">
                    <summary>
                      <Wrench size={14} />
                      {h.tools.length} tool call{h.tools.length > 1 ? 's' : ''}
                      {h.iterations != null && ` · ${h.iterations} iteration${h.iterations > 1 ? 's' : ''}`}
                    </summary>
                    <div className="qa-tools-list">
                      {h.tools.map((t, j) => (
                        <ToolCallCard key={j} tool={t} />
                      ))}
                    </div>
                  </details>
                )}
                <pre>{h.a}</pre>
                <span className="qa-model">
                  {h.fallback && <Zap size={11} />}
                  {!h.fallback && h.tools && <Bot size={11} />}
                  {h.model}
                </span>
              </div>
            </div>
          ))}

          {/* Live streaming response */}
          {isStreaming && (
            <div className="qa-exchange qa-streaming">
              <div className="qa-question">
                <strong>Q:</strong> {question}
              </div>
              <div className="qa-answer">
                {/* Tool activity feed */}
                {streamingTools.length > 0 && (
                  <div className="qa-tools-live">
                    <div className="qa-tools-live-header">
                      <Wrench size={14} />
                      <span>Tool Activity</span>
                    </div>
                    {streamingTools.map((t, i) => (
                      <ToolCallCard key={i} tool={t} />
                    ))}
                  </div>
                )}

                {/* Streaming status indicator */}
                {streamingStatus && (
                  <div className="qa-streaming-status">
                    {streamingError ? (
                      <><AlertCircle size={14} /> {streamingError}</>
                    ) : (
                      <><Loader size={14} className="spin" /> {streamingStatus}</>
                    )}
                  </div>
                )}

                {/* Streaming answer text */}
                {streamingAnswer && (
                  <pre className="qa-streaming-text">{streamingAnswer}<span className="qa-cursor">▋</span></pre>
                )}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="qa-input">
          <input
            type="text"
            value={question}
            onChange={e => onQuestionChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !answering && onAsk()}
            placeholder={agenticMode ? 'Ask a question (agent will use tools)…' : 'Ask a question…'}
            disabled={answering}
          />
          {isStreaming ? (
            <button className="qa-stop-btn" onClick={onStop} title="Stop generation">
              <StopCircle size={18} />
            </button>
          ) : (
            <button onClick={onAsk} disabled={answering || !question.trim()}>
              <Send size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tool Call Card (shows a single tool invocation) ──────────────

function ToolCallCard({ tool }: { tool: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const statusIcon = tool.status === 'running' ? <Loader size={13} className="spin" />
    : tool.status === 'done' ? <Check size={13} />
    : tool.status === 'error' ? <AlertCircle size={13} />
    : <Terminal size={13} />;

  const statusClass = `tool-status tool-${tool.status}`;

  // Try to format args as pretty JSON
  let prettyArgs = tool.args;
  if (tool.args) {
    try { prettyArgs = JSON.stringify(JSON.parse(tool.args), null, 2); } catch {}
  }

  return (
    <div className={`tool-call-card ${statusClass}`}>
      <div className="tool-call-header" onClick={() => setExpanded(e => !e)}>
        {statusIcon}
        <span className="tool-name">{tool.name}</span>
        {tool.durationMs != null && (
          <span className="tool-duration">{tool.durationMs}ms</span>
        )}
        {tool.status === 'error' && tool.error && (
          <span className="tool-error-msg">{tool.error}</span>
        )}
        {(tool.args || tool.result) && (
          expanded ? <ChevronUp size={13} className="tool-expand" /> : <ChevronDown size={13} className="tool-expand" />
        )}
      </div>
      {expanded && (
        <div className="tool-call-details">
          {prettyArgs && (
            <div className="tool-detail-section">
              <span className="tool-detail-label">Arguments:</span>
              <pre className="tool-detail-code">{prettyArgs}</pre>
            </div>
          )}
          {tool.result && (
            <div className="tool-detail-section">
              <span className="tool-detail-label">Result:</span>
              <pre className="tool-detail-code">{tool.result}</pre>
            </div>
          )}
          {tool.error && (
            <div className="tool-detail-section">
              <span className="tool-detail-label">Error:</span>
              <pre className="tool-detail-code tool-detail-error">{tool.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
