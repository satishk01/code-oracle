/**
 * LLM Enrichment
 *
 * Uses an LLM to enhance graph data and impact analysis beyond what
 * static analysis alone can provide.
 *
 * Graph enrichment:
 *  - Generates meaningful descriptions for nodes (functions, classes, modules)
 *    by reading the actual source code, replacing generic descriptions like
 *    "Function: foo" with "Validates user input and delegates to the auth service"
 *  - Validates architecture patterns by analyzing actual code structure instead
 *    of simple string matching
 *
 * Impact enrichment:
 *  - Explains WHY each impacted component is affected (not just THAT it is)
 *  - Assesses severity (critical/moderate/low) based on what the component does
 *  - Suggests which tests to run and what scenarios to verify
 */

import fs from 'fs';
import path from 'path';
import { LLMProvider, ChatMessage } from '../llm/provider.js';
import { BaseNode, Edge, ARCH_PATTERNS } from '../ontology/schema.js';

// ── Graph Enrichment ──────────────────────────────────────────────

/**
 * Enrich nodes with LLM-generated descriptions.
 * Batches nodes by file to minimize LLM calls — one call per file
 * covers all nodes in that file.
 */
export async function enrichNodeDescriptions(
  provider: LLMProvider,
  nodes: BaseNode[],
  repoRoot: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  // Group nodes by file
  const byFile = new Map<string, BaseNode[]>();
  for (const node of nodes) {
    // Skip patterns and packages — they already have descriptions
    if (node.kind === 'ArchPattern' || node.kind === 'Package') continue;
    if (!node.filePath) continue;
    const file = node.filePath;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(node);
  }

  const updates = new Map<string, string>(); // nodeId → new description
  const files = [...byFile.keys()];
  let done = 0;

  for (const relFile of files) {
    const absPath = path.join(repoRoot, relFile);
    if (!fs.existsSync(absPath)) { done++; continue; }

    const fileNodes = byFile.get(relFile)!;
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf-8');
    } catch { done++; continue; }

    // Truncate large files to avoid token limits
    const maxChars = 6000;
    const truncated = source.length > maxChars
      ? source.slice(0, maxChars) + '\n// ... (truncated)'
      : source;

    const nodeList = fileNodes
      .map((n, i) => `${i + 1}. [${n.kind}] ${n.qualifiedName} (line ${n.startLine})`)
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a code analysis assistant. You analyze source code and write concise, accurate descriptions of what each symbol does. You respond in valid JSON only, no markdown.',
      },
      {
        role: 'user',
        content: `Analyze this file and write a 1-2 sentence description for each symbol listed below. Focus on WHAT the symbol does and WHY it exists, not its signature.

File: ${relFile}

Source code:
\`\`\`
${truncated}
\`\`\`

Symbols to describe:
${nodeList}

Respond as a JSON array where each element is:
{"index": <1-based index>, "description": "<your description>"}

Only describe the listed symbols. Be specific and technical.`,
      },
    ];

    try {
      const response = await provider.chat(messages);
      const parsed = parseJsonArray(response);
      for (const item of parsed) {
        const idx = Number(item.index) - 1;
        if (idx >= 0 && idx < fileNodes.length && item.description) {
          updates.set(fileNodes[idx].id, String(item.description));
        }
      }
    } catch (err: any) {
      console.warn(`⚠ LLM enrichment failed for ${relFile}: ${err.message}`);
    }

    done++;
    onProgress?.(done, files.length);
  }

  return updates;
}

/**
 * Validate architecture patterns using the LLM.
 * Instead of just matching "Controller" in a class name, the LLM reads
 * the actual code and determines if the pattern is genuinely followed.
 *
 * Returns a map of pattern name → { confirmed: boolean, reasoning: string }
 */
export async function validatePatterns(
  provider: LLMProvider,
  nodes: BaseNode[],
  repoRoot: string,
): Promise<Map<string, { confirmed: boolean; reasoning: string; modules: string[] }>> {
  // Collect a sample of code from the repo to analyze
  const codeFiles = nodes
    .filter(n => n.kind === 'Module' && n.filePath)
    .slice(0, 20); // Limit to keep prompt size reasonable

  const codeSnippets: string[] = [];
  for (const mod of codeFiles) {
    const absPath = path.join(repoRoot, mod.filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const truncated = content.length > 1500
        ? content.slice(0, 1500) + '\n// ... (truncated)'
        : content;
      codeSnippets.push(`--- ${mod.filePath} ---\n${truncated}`);
    } catch {}
  }

  if (codeSnippets.length === 0) return new Map();

  const patternList = ARCH_PATTERNS.map(p => `- ${p.name}: signals are ${p.signals.join(', ')}`).join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a software architecture expert. You analyze code and determine which architectural patterns are genuinely implemented. You respond in valid JSON only, no markdown.',
    },
    {
      role: 'user',
      content: `Analyze this codebase and determine which of these architectural patterns are genuinely implemented (not just named superficially).

Possible patterns:
${patternList}

Code samples from the repository:
${codeSnippets.join('\n\n')}

For each pattern, respond with:
{"pattern": "<pattern name>", "confirmed": true/false, "reasoning": "<1-2 sentences explaining why>", "modules": ["file paths that implement this pattern"]}

Respond as a JSON array. Only include patterns you can confirm or reject with evidence from the code.`,
    },
  ];

  try {
    const response = await provider.chat(messages);
    const parsed = parseJsonArray(response);
    const result = new Map<string, { confirmed: boolean; reasoning: string; modules: string[] }>();
    for (const item of parsed) {
      if (item.pattern && typeof item.confirmed === 'boolean') {
        result.set(String(item.pattern), {
          confirmed: item.confirmed,
          reasoning: String(item.reasoning || ''),
          modules: Array.isArray(item.modules) ? item.modules.map(String) : [],
        });
      }
    }
    return result;
  } catch (err: any) {
    console.warn(`⚠ Pattern validation failed: ${err.message}`);
    return new Map();
  }
}

// ── Impact Enrichment ─────────────────────────────────────────────

export interface LlmImpactEnrichment {
  /** Natural language explanation of the overall impact */
  explanation: string;
  /** Per-impacted-component severity and reasoning */
  severityAssessments: { nodeId: string; name: string; severity: 'critical' | 'moderate' | 'low'; reasoning: string }[];
  /** Suggested tests and verification scenarios */
  testSuggestions: string[];
}

/**
 * Enrich an impact report with LLM-generated explanations,
 * severity assessments, and test suggestions.
 */
export async function enrichImpactAnalysis(
  provider: LLMProvider,
  report: {
    changedFiles: string[];
    directImpacts: { node: BaseNode; depth: number; impactScore: number; reason: string }[];
    transitiveImpacts: { node: BaseNode; depth: number; impactScore: number; reason: string }[];
    affectedEndpoints: { node: BaseNode; depth: number; impactScore: number; reason: string }[];
    affectedPatterns: string[];
    riskScore: number;
    summary: string;
  },
  repoRoot: string,
): Promise<LlmImpactEnrichment> {
  // Gather context about changed files
  const changedFileContents: string[] = [];
  for (const filePath of report.changedFiles.slice(0, 5)) {
    const absPath = path.join(repoRoot, filePath);
    if (fs.existsSync(absPath)) {
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const truncated = content.length > 2000
          ? content.slice(0, 2000) + '\n// ... (truncated)'
          : content;
        changedFileContents.push(`--- ${filePath} ---\n${truncated}`);
      } catch {}
    }
  }

  // Build a summary of impacted components
  const allImpacts = [
    ...report.directImpacts,
    ...report.transitiveImpacts,
    ...report.affectedEndpoints,
  ];

  const impactList = allImpacts.slice(0, 20).map((imp, i) => {
    const n = imp.node;
    return `${i + 1}. [${n.kind}] ${n.qualifiedName} (${n.filePath}:${n.startLine}) — ${imp.reason} (score: ${imp.impactScore.toFixed(2)})`;
  }).join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a senior software engineer performing impact analysis. You explain WHY changes affect other components, assess severity, and suggest tests. You respond in valid JSON only, no markdown.`,
    },
    {
      role: 'user',
      content: `An impact analysis was run on a codebase. Here are the results:

Changed files: ${report.changedFiles.join(', ')}
Risk score: ${report.riskScore}/100

Changed file contents:
${changedFileContents.join('\n\n') || '(files not available)'}

Impacted components (top 20):
${impactList || '(none)'}

Affected patterns: ${report.affectedPatterns.join(', ') || 'none'}

Provide your analysis as JSON with this structure:
{
  "explanation": "<2-3 paragraphs explaining the overall impact, what might break, and why>",
  "severityAssessments": [
    {"name": "<component qualified name>", "severity": "critical|moderate|low", "reasoning": "<why this severity>"}
  ],
  "testSuggestions": [
    "<specific test or verification scenario to run>"
  ]
}

Focus on actionable insights. For severity, consider:
- critical: breaking changes, API contract violations, data loss risk
- moderate: behavioral changes, needs testing but unlikely to break
- low: cosmetic, logging, or non-functional changes`,
    },
  ];

  try {
    const response = await provider.chat(messages);
    const parsed = parseJsonObject(response);
    return {
      explanation: String(parsed.explanation || 'LLM analysis unavailable.'),
      severityAssessments: Array.isArray(parsed.severityAssessments)
        ? parsed.severityAssessments.map((s: any) => ({
            nodeId: '',
            name: String(s.name || ''),
            severity: (['critical', 'moderate', 'low'].includes(s.severity) ? s.severity : 'moderate') as 'critical' | 'moderate' | 'low',
            reasoning: String(s.reasoning || ''),
          }))
        : [],
      testSuggestions: Array.isArray(parsed.testSuggestions)
        ? parsed.testSuggestions.map(String)
        : [],
    };
  } catch (err: any) {
    return {
      explanation: `LLM impact analysis failed: ${err.message}`,
      severityAssessments: [],
      testSuggestions: [],
    };
  }
}

// ── Requirement Impact & Planning Enrichment ────────────────────────

export interface LlmRequirementEnrichment {
  explanation: string;
  implementationPlan: {
    phase: string;
    action: 'create' | 'modify' | 'configure' | 'test' | 'optimize';
    title: string;
    targetFile: string;
    description: string;
    details: string[];
  }[];
  bottleneckAnalysis: string;
  severityAssessments: { name: string; severity: 'critical' | 'moderate' | 'low'; reasoning: string }[];
  testSuggestions: string[];
}

/**
 * Deep LLM enrichment for requirement-based impact analysis.
 * Generates an executive explanation, step-by-step implementation plan,
 * performance bottleneck diagnosis, component risk assessments, and test suite.
 */
export async function enrichRequirementImpact(
  provider: LLMProvider,
  context: {
    requirement: string;
    detectedIntents: string[];
    matchedEntities: { node: BaseNode; score: number; matchReason: string }[];
    impactedEntities: { node: BaseNode; depth: number; reason: string }[];
    affectedEndpoints: BaseNode[];
    performanceBottlenecks: { component: string; filePath: string; metrics: string; riskExplanation: string }[];
    riskScore: number;
  },
  repoRoot: string,
): Promise<LlmRequirementEnrichment> {
  // Extract snippet from the top 3 relevant target files
  const relevantFiles = Array.from(new Set(
    context.matchedEntities
      .map(m => m.node.filePath)
      .filter(f => f && f !== '(unknown)' && f !== '—')
  )).slice(0, 3);

  const fileSnippets: string[] = [];
  for (const relPath of relevantFiles) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
    if (fs.existsSync(absPath)) {
      try {
        const text = fs.readFileSync(absPath, 'utf-8');
        const snippet = text.slice(0, 2500);
        fileSnippets.push(`File: ${relPath}\n\`\`\`\n${snippet}\n\`\`\``);
      } catch {}
    }
  }

  const matchedSummary = context.matchedEntities.slice(0, 15).map((m, i) =>
    `${i + 1}. [${m.node.kind}] ${m.node.name} (${m.node.filePath}:${m.node.startLine}) — ${m.matchReason}`
  ).join('\n') || '(no direct component matches)';

  const endpointSummary = context.affectedEndpoints.slice(0, 10).map((e, i) =>
    `${i + 1}. ${e.name} (${e.filePath})`
  ).join('\n') || '(none)';

  const bottleneckSummary = context.performanceBottlenecks.slice(0, 5).map((b, i) =>
    `${i + 1}. ${b.component} in ${b.filePath} (${b.metrics}) — ${b.riskExplanation}`
  ).join('\n') || '(none detected)';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a Principal Software Architect conducting an impact analysis and creating an implementation roadmap for a codebase change or new requirement.
You provide technical, concrete, and production-ready recommendations based on the actual codebase structure.
You respond in valid JSON ONLY, with NO markdown code fences outside of JSON.`,
    },
    {
      role: 'user',
      content: `Analyze the following requirement for the codebase and produce an architectural impact report and step-by-step implementation plan.

Requirement: "${context.requirement}"
Detected Intents: ${context.detectedIntents.join(', ')}
Calculated Risk Score: ${context.riskScore}/100

Primary Target Components:
${matchedSummary}

Existing API Endpoints:
${endpointSummary}

Identified Coupling & Performance Bottlenecks:
${bottleneckSummary}

Source Code Snippets of Primary Target Files:
${fileSnippets.join('\n\n') || '(source unavailable)'}

Respond with a JSON object matching this exact structure:
{
  "explanation": "<2-3 paragraphs explaining the blast radius, architecture considerations, what existing components need modification, and how to structure the changes cleanly>",
  "implementationPlan": [
    {
      "phase": "<e.g. '1. Architecture & API Contracts' or '2. Core Service Logic'>",
      "action": "<one of: 'create' | 'modify' | 'configure' | 'test' | 'optimize'>",
      "title": "<Concise step title>",
      "targetFile": "<Specific file path to create or modify, e.g. src/api/server.ts>",
      "description": "<What needs to be implemented in this step>",
      "details": [
        "<bullet point with specific code / interface / function details>",
        "<bullet point with error handling or edge case>"
      ]
    }
  ],
  "bottleneckAnalysis": "<Detailed analysis of potential performance bottlenecks, database query load, coupling risks, and specific mitigation advice>",
  "severityAssessments": [
    {
      "name": "<component name or qualified name>",
      "severity": "<critical | moderate | low>",
      "reasoning": "<why this severity rating was assigned>"
    }
  ],
  "testSuggestions": [
    "<specific unit, integration, or load test scenario to write and verify>"
  ]
}`,
    },
  ];

  try {
    const response = await provider.chat(messages);
    const parsed = parseJsonObject(response);

    return {
      explanation: String(parsed.explanation || 'LLM analysis complete.'),
      implementationPlan: Array.isArray(parsed.implementationPlan) && parsed.implementationPlan.length > 0
        ? parsed.implementationPlan.map((p: any) => ({
            phase: String(p.phase || 'Phase'),
            action: (['create', 'modify', 'configure', 'test', 'optimize'].includes(p.action) ? p.action : 'modify') as any,
            title: String(p.title || 'Step'),
            targetFile: String(p.targetFile || ''),
            description: String(p.description || ''),
            details: Array.isArray(p.details) ? p.details.map(String) : [],
          }))
        : [],
      bottleneckAnalysis: String(parsed.bottleneckAnalysis || 'No critical bottlenecks identified.'),
      severityAssessments: Array.isArray(parsed.severityAssessments)
        ? parsed.severityAssessments.map((s: any) => ({
            name: String(s.name || ''),
            severity: (['critical', 'moderate', 'low'].includes(s.severity) ? s.severity : 'moderate') as 'critical' | 'moderate' | 'low',
            reasoning: String(s.reasoning || ''),
          }))
        : [],
      testSuggestions: Array.isArray(parsed.testSuggestions)
        ? parsed.testSuggestions.map(String)
        : [],
    };
  } catch (err: any) {
    return {
      explanation: `LLM requirement analysis failed: ${err.message}`,
      implementationPlan: [],
      bottleneckAnalysis: 'LLM bottleneck analysis unavailable.',
      severityAssessments: [],
      testSuggestions: [],
    };
  }
}

// ── JSON parsing helpers ──────────────────────────────────────────

/** Extract and parse a JSON array from an LLM response (handles markdown fences) */
function parseJsonArray(text: string): any[] {
  const cleaned = stripMarkdownFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Try to find a JSON array in the text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return [];
  }
}

/** Extract and parse a JSON object from an LLM response */
function parseJsonObject(text: string): Record<string, any> {
  const cleaned = stripMarkdownFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return {};
  }
}

function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}
