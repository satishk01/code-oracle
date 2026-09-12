/**
 * Impact & Roadmap Report Exporter
 *
 * Formats Code-Based and Requirement-Based Impact Reports into:
 *  - Markdown (.md)
 *  - Standalone styled HTML (.html)
 *
 * Triggers direct browser downloads based on user preference.
 */
export function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
function esc(s) {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function inlineMd(text) {
    return (text || '')
        .replace(/`([^`]+)`/g, (_, code) => `<code>${esc(code)}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
export function markdownToHtml(md, title) {
    const lines = md.split('\n');
    const html = [];
    let inTable = false;
    let inList = false;
    let listType = 'ul';
    let inBlockquote = false;
    let para = [];
    function flushPara() {
        if (para.length > 0) {
            html.push(`<p>${inlineMd(para.join(' '))}</p>`);
            para = [];
        }
    }
    function closeList() {
        if (inList) {
            html.push(`</${listType}>`);
            inList = false;
        }
    }
    function closeTable() {
        if (inTable) {
            html.push('</tbody></table>');
            inTable = false;
        }
    }
    function closeBlockquote() {
        if (inBlockquote) {
            html.push('</blockquote>');
            inBlockquote = false;
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Code block
        if (line.trim().startsWith('```')) {
            flushPara();
            closeList();
            closeTable();
            closeBlockquote();
            const lang = line.trim().slice(3).trim();
            const codeLines = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            const langClass = lang ? ` class="language-${esc(lang)}"` : '';
            html.push(`<pre><code${langClass}>${esc(codeLines.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^---+$/.test(line.trim())) {
            flushPara();
            closeList();
            closeTable();
            closeBlockquote();
            html.push('<hr/>');
            continue;
        }
        const hMatch = line.match(/^(#{1,6})\s+(.*)/);
        if (hMatch) {
            flushPara();
            closeList();
            closeTable();
            closeBlockquote();
            const level = hMatch[1].length;
            const text = inlineMd(hMatch[2]);
            const id = hMatch[2].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            html.push(`<h${level} id="${id}">${text}</h${level}>`);
            continue;
        }
        if (line.startsWith('>')) {
            flushPara();
            closeList();
            closeTable();
            if (!inBlockquote) {
                html.push('<blockquote>');
                inBlockquote = true;
            }
            html.push(`<p>${inlineMd(line.slice(1).trim())}</p>`);
            continue;
        }
        else {
            closeBlockquote();
        }
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            flushPara();
            closeList();
            const cells = line.trim().split('|').slice(1, -1);
            if (cells.every(c => /^[\s:-]*-+[\s:-]*$/.test(c))) {
                continue;
            }
            if (!inTable) {
                html.push('<table><thead><tr>');
                for (const c of cells)
                    html.push(`<th>${inlineMd(c.trim())}</th>`);
                html.push('</tr></thead><tbody>');
                inTable = true;
                continue;
            }
            html.push('<tr>');
            for (const c of cells)
                html.push(`<td>${inlineMd(c.trim())}</td>`);
            html.push('</tr>');
            continue;
        }
        else {
            closeTable();
        }
        if (/^\s*[-*]\s+/.test(line)) {
            flushPara();
            closeTable();
            if (!inList || listType !== 'ul') {
                closeList();
                html.push('<ul>');
                inList = true;
                listType = 'ul';
            }
            html.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
            continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            flushPara();
            closeTable();
            if (!inList || listType !== 'ol') {
                closeList();
                html.push('<ol>');
                inList = true;
                listType = 'ol';
            }
            html.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
            continue;
        }
        closeList();
        if (line.trim() === '') {
            flushPara();
            continue;
        }
        para.push(line.trim());
    }
    flushPara();
    closeList();
    closeTable();
    closeBlockquote();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #0f1117; --bg-card: #181c28; --text: #e8eaf0; --text-muted: #9ba3b8;
    --border: #262c3e; --code-bg: #1e2436; --accent: #6366f1; --link: #818cf8;
    --red: #ef4444; --amber: #f59e0b; --green: #22c55e;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff; --bg-card: #f9fafb; --text: #111827; --text-muted: #6b7280;
      --border: #e5e7eb; --code-bg: #f3f4f6; --accent: #4f46e5; --link: #4f46e5;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.6; max-width: 960px; margin: 0 auto; padding: 40px 24px;
  }
  h1 { font-size: 2em; border-bottom: 2px solid var(--border); padding-bottom: 10px; margin-bottom: 20px; color: var(--text); }
  h2 { font-size: 1.5em; margin-top: 2em; border-bottom: 1px solid var(--border); padding-bottom: 6px; color: var(--text); }
  h3 { font-size: 1.25em; margin-top: 1.6em; color: var(--text); }
  h4 { font-size: 1.05em; margin-top: 1.2em; }
  p { margin: 12px 0; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: 'IBM Plex Mono', 'Fira Code', monospace;
    background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
    font-size: 0.9em;
  }
  pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--border); }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 0.92em; }
  th, td { border: 1px solid var(--border); padding: 9px 13px; text-align: left; }
  th { background: var(--code-bg); font-weight: 600; color: var(--text); }
  tr:nth-child(even) { background: color-mix(in srgb, var(--code-bg) 50%, transparent); }
  blockquote {
    border-left: 4px solid var(--accent); margin: 16px 0; padding: 12px 18px;
    color: var(--text); background: var(--code-bg); border-radius: 0 8px 8px 0;
    font-style: italic;
  }
  hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
  ul, ol { padding-left: 24px; margin: 10px 0; }
  li { margin: 6px 0; }
  .badge {
    display: inline-block; padding: 3px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 700; text-transform: uppercase;
  }
  @media print { body { max-width: none; } }
</style>
</head>
<body>
${html.join('\n')}
</body>
</html>`;
}
// ── Code-Based Impact Exporter ────────────────────────────────────────
export function generateCodeImpactMarkdown(report, filesAnalyzed) {
    const lines = [];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`# Code-Based Impact Analysis Report`);
    lines.push('');
    lines.push(`> Generated on ${now} by Codebase Oracle`);
    lines.push(`> Files Analyzed:\n\`\`\`\n${filesAnalyzed.trim()}\n\`\`\``);
    lines.push('');
    lines.push('---');
    lines.push('');
    // Overall Risk Score
    lines.push(`## Overall Risk Assessment`);
    lines.push('');
    lines.push(`- **Risk Score:** **${report.riskScore}/100**`);
    lines.push(`- **Direct Impacts:** ${report.directImpacts?.length || 0}`);
    lines.push(`- **Transitive Impacts:** ${report.transitiveImpacts?.length || 0}`);
    lines.push(`- **Affected API Endpoints:** ${report.affectedEndpoints?.length || 0}`);
    lines.push(`- **Affected Architectural Patterns:** ${report.affectedPatterns?.length || 0}`);
    lines.push('');
    // Affected API Endpoints
    if (report.affectedEndpoints && report.affectedEndpoints.length > 0) {
        lines.push(`## Affected API Endpoints (${report.affectedEndpoints.length})`);
        lines.push('');
        lines.push('| Endpoint / Function | Location | Risk | Coupling Reason |');
        lines.push('|---------------------|----------|------|-----------------|');
        for (const ep of report.affectedEndpoints) {
            const risk = (ep.impactScore * 100).toFixed(0);
            lines.push(`| \`${ep.node.name}\` | \`${ep.node.filePath}:${ep.node.startLine}\` | ${risk}% | ${ep.reason} |`);
        }
        lines.push('');
    }
    // Direct Impacts
    if (report.directImpacts && report.directImpacts.length > 0) {
        lines.push(`## Directly Impacted Components (${report.directImpacts.length})`);
        lines.push('');
        lines.push('| Kind | Component | Location | Impact Score |');
        lines.push('|------|-----------|----------|--------------|');
        for (const d of report.directImpacts) {
            const score = (d.impactScore * 100).toFixed(0);
            lines.push(`| ${d.node.kind} | \`${d.node.name}\` | \`${d.node.filePath}:${d.node.startLine}\` | ${score}% |`);
        }
        lines.push('');
    }
    // Transitive Impacts
    if (report.transitiveImpacts && report.transitiveImpacts.length > 0) {
        lines.push(`## Transitive Blast Radius (${report.transitiveImpacts.length})`);
        lines.push('');
        lines.push('| Kind | Component | Relationship / Call Chain |');
        lines.push('|------|-----------|---------------------------|');
        for (const t of report.transitiveImpacts) {
            lines.push(`| ${t.node.kind} | \`${t.node.name}\` | ${t.reason} |`);
        }
        lines.push('');
    }
    // Affected Patterns
    if (report.affectedPatterns && report.affectedPatterns.length > 0) {
        lines.push(`## Affected Architectural Patterns`);
        lines.push('');
        for (const p of report.affectedPatterns) {
            lines.push(`- **${p}**`);
        }
        lines.push('');
    }
    // LLM Enrichment
    if (report.llmEnrichment) {
        lines.push(`## LLM Architectural Assessment`);
        lines.push('');
        lines.push(report.llmEnrichment.explanation);
        lines.push('');
        if (report.llmEnrichment.severityAssessments?.length > 0) {
            lines.push(`### Component Severity Breakdown`);
            lines.push('');
            lines.push('| Component | Severity | Assessment / Rationale |');
            lines.push('|-----------|----------|------------------------|');
            for (const sa of report.llmEnrichment.severityAssessments) {
                lines.push(`| \`${sa.name}\` | **${sa.severity.toUpperCase()}** | ${sa.reasoning} |`);
            }
            lines.push('');
        }
        if (report.llmEnrichment.testSuggestions?.length > 0) {
            lines.push(`### Recommended Verification & Tests`);
            lines.push('');
            for (const ts of report.llmEnrichment.testSuggestions) {
                lines.push(`- ${ts}`);
            }
            lines.push('');
        }
    }
    lines.push('---');
    lines.push(`*Report generated by Codebase Oracle on ${now}*`);
    return lines.join('\n');
}
// ── Requirement-Based Impact Exporter ─────────────────────────────────
export function generateRequirementPlanMarkdown(report) {
    const lines = [];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`# Requirement Impact & Implementation Roadmap`);
    lines.push('');
    lines.push(`> Generated on ${now} by Codebase Oracle`);
    lines.push(`> **Requirement:** "${report.requirement}"`);
    if (report.detectedIntents && report.detectedIntents.length > 0) {
        lines.push(`> **Detected Domains/Intents:** ${report.detectedIntents.join(', ')}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    // Executive Overview
    lines.push(`## Executive Overview`);
    lines.push('');
    lines.push(`- **Risk Score:** **${report.riskScore}/100**`);
    lines.push(`- **Primary Target Components:** ${report.matchedEntities?.length || 0}`);
    lines.push(`- **Transitive Dependencies/Callers:** ${report.impactedEntities?.length || 0}`);
    lines.push(`- **API Endpoints Touched:** ${report.affectedEndpoints?.length || 0}`);
    lines.push(`- **Performance Hotspots Identified:** ${report.performanceBottlenecks?.length || 0}`);
    lines.push(`- **Implementation Steps:** ${report.implementationPlan?.length || 0}`);
    lines.push('');
    // 1. Implementation Roadmap
    if (report.implementationPlan && report.implementationPlan.length > 0) {
        lines.push(`## Step-by-Step Implementation Roadmap`);
        lines.push('');
        for (let i = 0; i < report.implementationPlan.length; i++) {
            const step = report.implementationPlan[i];
            const action = (step.action || 'MODIFY').toUpperCase();
            lines.push(`### Step ${i + 1}: ${step.title} \`[${action}]\``);
            lines.push('');
            if (step.phase)
                lines.push(`- **Phase:** ${step.phase}`);
            if (step.targetFile)
                lines.push(`- **Target File:** \`${step.targetFile}\``);
            lines.push(`- **Description:** ${step.description}`);
            if (step.details && step.details.length > 0) {
                lines.push('');
                lines.push(`**Implementation Details:**`);
                for (const d of step.details) {
                    lines.push(`- ${d}`);
                }
            }
            lines.push('');
        }
    }
    // 2. Performance Bottlenecks & Hotspots
    if (report.performanceBottlenecks && report.performanceBottlenecks.length > 0) {
        lines.push(`## Performance Bottlenecks & Coupling Hotspots`);
        lines.push('');
        for (const bn of report.performanceBottlenecks) {
            lines.push(`### \`${bn.component}\` (${bn.severity.toUpperCase()} Priority)`);
            lines.push('');
            lines.push(`- **Location:** \`${bn.filePath}\``);
            lines.push(`- **Type:** ${bn.type}`);
            lines.push(`- **Coupling Metric:** ${bn.metrics}`);
            lines.push(`- **Risk Explanation:** ${bn.riskExplanation}`);
            lines.push(`- **Recommendation:** ${bn.recommendation}`);
            lines.push('');
        }
    }
    // 3. Affected API Endpoints
    if (report.affectedEndpoints && report.affectedEndpoints.length > 0) {
        lines.push(`## Existing API Endpoints Touched (${report.affectedEndpoints.length})`);
        lines.push('');
        lines.push('| Endpoint / Route | Location | Description |');
        lines.push('|------------------|----------|-------------|');
        for (const ep of report.affectedEndpoints) {
            lines.push(`| \`${ep.name}\` | \`${ep.filePath}:${ep.startLine}\` | ${ep.description || 'API Endpoint'} |`);
        }
        lines.push('');
    }
    // 4. Primary Matched Target Components
    if (report.matchedEntities && report.matchedEntities.length > 0) {
        lines.push(`## Primary Target Components (${report.matchedEntities.length})`);
        lines.push('');
        lines.push('| Kind | Component | Location | Match Rationale |');
        lines.push('|------|-----------|----------|-----------------|');
        for (const m of report.matchedEntities) {
            lines.push(`| ${m.node.kind} | \`${m.node.name}\` | \`${m.node.filePath}:${m.node.startLine}\` | ${m.matchReason} |`);
        }
        lines.push('');
    }
    // 5. Transitive Blast Radius
    if (report.impactedEntities && report.impactedEntities.length > 0) {
        lines.push(`## Transitive Dependencies & Callers (${report.impactedEntities.length})`);
        lines.push('');
        lines.push('| Kind | Component | Relationship / Reason |');
        lines.push('|------|-----------|-----------------------|');
        for (const imp of report.impactedEntities) {
            lines.push(`| ${imp.node.kind} | \`${imp.node.name}\` | ${imp.reason} |`);
        }
        lines.push('');
    }
    // 6. LLM Deep Analysis
    if (report.llmEnrichment) {
        lines.push(`## LLM Deep Architectural Analysis`);
        lines.push('');
        lines.push(report.llmEnrichment.explanation);
        lines.push('');
        if (report.llmEnrichment.bottleneckAnalysis) {
            lines.push(`### Deep Bottleneck Diagnosis`);
            lines.push('');
            lines.push(report.llmEnrichment.bottleneckAnalysis);
            lines.push('');
        }
        if (report.llmEnrichment.severityAssessments?.length > 0) {
            lines.push(`### Component Severity Assessments`);
            lines.push('');
            lines.push('| Component | Severity | Assessment |');
            lines.push('|-----------|----------|------------|');
            for (const sa of report.llmEnrichment.severityAssessments) {
                lines.push(`| \`${sa.name}\` | **${sa.severity.toUpperCase()}** | ${sa.reasoning} |`);
            }
            lines.push('');
        }
        if (report.llmEnrichment.testSuggestions?.length > 0) {
            lines.push(`### Verification & Test Strategy`);
            lines.push('');
            for (const ts of report.llmEnrichment.testSuggestions) {
                lines.push(`- ${ts}`);
            }
            lines.push('');
        }
    }
    lines.push('---');
    lines.push(`*Plan generated by Codebase Oracle on ${now}*`);
    return lines.join('\n');
}
// ── Export Dispatcher Functions ───────────────────────────────────────
export function exportCodeImpact(report, filesAnalyzed, format) {
    const md = generateCodeImpactMarkdown(report, filesAnalyzed);
    const slug = (filesAnalyzed.split(/[\r\n]+/)[0] || 'code')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .slice(0, 30);
    const dateStr = new Date().toISOString().slice(0, 10);
    if (format === 'html') {
        const html = markdownToHtml(md, 'Code Impact Analysis Report');
        downloadFile(`code-impact-${slug}-${dateStr}.html`, html, 'text/html');
    }
    else {
        downloadFile(`code-impact-${slug}-${dateStr}.md`, md, 'text/markdown');
    }
}
export function exportRequirementPlan(report, format) {
    const md = generateRequirementPlanMarkdown(report);
    const slug = (report.requirement || 'requirement')
        .toLowerCase()
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 35);
    const dateStr = new Date().toISOString().slice(0, 10);
    if (format === 'html') {
        const html = markdownToHtml(md, 'Requirement Impact & Implementation Roadmap');
        downloadFile(`requirement-plan-${slug}-${dateStr}.html`, html, 'text/html');
    }
    else {
        downloadFile(`requirement-plan-${slug}-${dateStr}.md`, md, 'text/markdown');
    }
}
//# sourceMappingURL=impactExporter.js.map