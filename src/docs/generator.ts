/**
 * Documentation Generator
 *
 * Generates exhaustive, production-ready documentation from the knowledge graph
 * AND the live filesystem. Pulls all nodes + edges from the graph store, reads
 * real files from the repo root (README, package.json, .env.example, Docker,
 * tsconfig, source snippets), and organizes everything into a structured
 * developer knowledge base and business/technical handbook.
 *
 * Supports multiple categories:
 *  - Technical Code Reference: classes, interfaces, functions, types, modules
 *    with full signatures, per-entity relationship maps, and inline source
 *    snippets
 *  - Business / Functional Overview: business domains, user workflows, entry
 *    points, and system touchpoints — enriched with README content
 *  - Architecture & Design: Mermaid diagrams, layered architecture narrative,
 *    call-graph hotspots, dependency analysis, deployment view
 *  - API Reference: endpoints grouped by router/controller, with full paths,
 *    handler cross-references, and per-endpoint detail cards
 *  - Developer Guide: prerequisites, step-by-step setup, environment variables,
 *    build/test/run commands, deployment, project structure
 *
 * Output formats: Markdown (.md) or standalone HTML (.html).
 *
 * LLM enrichment is opt-in via `includeLlmSummary` + an optional `provider`:
 *  - Executive summary at the top of the document
 *  - Per-business-domain workflow narratives
 *  - Per-endpoint descriptions where JSDoc is absent
 */

import { GraphStore } from '../graph/store.js';
import { BaseNode, Edge } from '../ontology/schema.js';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import {
  gatherFsContext,
  readSourceSnippet,
  formatSnippet,
  type FsContext,
  type PackageJsonFull,
} from './fs-context.js';
import path from 'path';

export type DocFormat = 'md' | 'html';
export type DocCategory = 'technical' | 'business' | 'architecture' | 'api' | 'developer';

export interface DocGenOptions {
  format: DocFormat;
  /** List of categories to include in the document */
  categories?: DocCategory[];
  /** Optional: use the LLM to write narrative summaries and descriptions. */
  includeLlmSummary?: boolean;
  /** Optional LLM provider for narrative enrichment (requires includeLlmSummary). */
  provider?: LLMProvider;
}

export interface DocGenResult {
  content: string;
  format: DocFormat;
  filename: string;
}

interface PreparedData {
  stats: Record<string, number>;
  patterns: BaseNode[];
  endpoints: BaseNode[];
  allNodes: BaseNode[];
  allEdges: Edge[];
  nodesByFile: Map<string, BaseNode[]>;
  nodesByKind: Map<string, BaseNode[]>;
  edgesByKind: Map<string, Edge[]>;
  outgoingEdges: Map<string, Edge[]>; // nodeId → edges where node is source
  incomingEdges: Map<string, Edge[]>; // nodeId → edges where node is target
  packages: BaseNode[];
  nodeById: Map<string, BaseNode>; // nodeId → node (for edge resolution)
  fsCtx: FsContext;
}

// ── Data gathering ──────────────────────────────────────────────────

async function gatherData(store: GraphStore, repoRoot: string): Promise<PreparedData> {
  const [stats, patterns, endpoints, allNodes, allEdges] = await Promise.all([
    store.getStats(),
    store.getNodesByKind('ArchPattern'),
    store.getNodesByKind('APIEndpoint'),
    store.getAllNodes(),
    store.getAllEdges(),
  ]);

  const nodesByFile = new Map<string, BaseNode[]>();
  const nodesByKind = new Map<string, BaseNode[]>();
  const edgesByKind = new Map<string, Edge[]>();
  const outgoingEdges = new Map<string, Edge[]>();
  const incomingEdges = new Map<string, Edge[]>();
  const nodeById = new Map<string, BaseNode>();

  for (const node of allNodes) {
    const file = node.filePath || '(unknown)';
    if (!nodesByFile.has(file)) nodesByFile.set(file, []);
    nodesByFile.get(file)!.push(node);

    if (!nodesByKind.has(node.kind)) nodesByKind.set(node.kind, []);
    nodesByKind.get(node.kind)!.push(node);

    nodeById.set(node.id, node);
  }

  for (const edge of allEdges) {
    if (!edgesByKind.has(edge.kind)) edgesByKind.set(edge.kind, []);
    edgesByKind.get(edge.kind)!.push(edge);

    if (!outgoingEdges.has(edge.fromId)) outgoingEdges.set(edge.fromId, []);
    outgoingEdges.get(edge.fromId)!.push(edge);

    if (!incomingEdges.has(edge.toId)) incomingEdges.set(edge.toId, []);
    incomingEdges.get(edge.toId)!.push(edge);
  }

  const packages = nodesByKind.get('Package') ?? [];
  const fsCtx = gatherFsContext(repoRoot);

  return {
    stats, patterns, endpoints, allNodes, allEdges,
    nodesByFile, nodesByKind, edgesByKind,
    outgoingEdges, incomingEdges, packages,
    nodeById, fsCtx,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseMeta(node: BaseNode): Record<string, any> {
  try { return JSON.parse(node.metadata || '{}'); } catch { return {}; }
}

function edgeLabel(kind: string): string {
  const labels: Record<string, string> = {
    IMPORTS: 'imports',
    EXPORTS: 'exports',
    CONTAINS: 'contains',
    EXTENDS: 'extends',
    IMPLEMENTS: 'implements',
    CALLS: 'calls',
    INSTANTIATES: 'instantiates',
    USES_TYPE: 'uses type',
    DEPENDS_ON: 'depends on',
    EXPOSES: 'exposes',
    FOLLOWS_PATTERN: 'follows pattern',
    READS_CONFIG: 'reads config',
    DECORATES: 'decorates',
  };
  return labels[kind] || kind.toLowerCase();
}

// ── Cross-reference & signature helpers ──────────────────────────────

/** Generate a stable Markdown anchor ID for a node (used for cross-referencing). */
function nodeAnchorId(node: BaseNode): string {
  // Use kind + qualifiedName for uniqueness, sanitized for URL
  const raw = `${node.kind}-${node.qualifiedName}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Format a node as a Markdown link to its anchor (if target is a documented entity). */
function nodeLink(node: BaseNode | undefined, data: PreparedData): string {
  if (!node) return '_(unknown)_';
  const documented = ['Class', 'Interface', 'Function', 'Method', 'TypeAlias', 'Enum', 'Namespace', 'Variable', 'Module', 'APIEndpoint', 'ArchPattern'];
  if (documented.includes(node.kind)) {
    return `[\`${node.name}\`](#${nodeAnchorId(node)})`;
  }
  return `\`${node.name}\``;
}

/** Resolve an edge endpoint to its node, safely. */
function resolveNode(id: string, data: PreparedData): BaseNode | undefined {
  return data.nodeById.get(id);
}

/**
 * Reconstruct a human-readable signature from node metadata.
 * Uses paramCount, returnType, isAsync, isStatic, visibility, isExported, etc.
 */
function formatSignature(node: BaseNode, meta: Record<string, any>): string {
  switch (node.kind) {
    case 'Function': {
      const asyncKw = meta.isAsync ? 'async ' : '';
      const genKw = meta.isGenerator ? '*' : '';
      const exported = meta.isExported ? 'export ' : '';
      const params = paramPlaceholder(meta.paramCount);
      const ret = meta.returnType ? `: ${meta.returnType}` : '';
      return `${exported}${asyncKw}function${genKw} ${node.name}(${params})${ret}`;
    }
    case 'Method': {
      const asyncKw = meta.isAsync ? 'async ' : '';
      const staticKw = meta.isStatic ? 'static ' : '';
      const vis = meta.visibility && meta.visibility !== 'public' ? `${meta.visibility} ` : '';
      const params = paramPlaceholder(meta.paramCount);
      const ret = meta.returnType ? `: ${meta.returnType}` : '';
      return `${vis}${staticKw}${asyncKw}${node.name}(${params})${ret}`;
    }
    case 'Class': {
      const exported = meta.isExported ? 'export ' : '';
      const abstract = meta.isAbstract ? 'abstract ' : '';
      const decs = meta.decorators?.length ? `@${meta.decorators.join(' @')} ` : '';
      return `${decs}${exported}${abstract}class ${node.name}`;
    }
    case 'Interface': {
      const exported = meta.isExported ? 'export ' : '';
      return `${exported}interface ${node.name}`;
    }
    case 'TypeAlias': {
      const exported = meta.isExported ? 'export ' : '';
      return `${exported}type ${node.name}`;
    }
    case 'Enum': {
      const exported = meta.isExported ? 'export ' : '';
      return `${exported}enum ${node.name}`;
    }
    default:
      return node.name;
  }
}

/** Generate a parameter placeholder like `a, b, c` or `…` for N params. */
function paramPlaceholder(count: number): string {
  if (!count || count <= 0) return '';
  if (count <= 4) {
    return Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i)).join(', ');
  }
  return `…${count} params`;
}

/**
 * Build per-entity relationship blocks using the graph's edge data.
 * Returns an array of markdown lines (empty if no relationships).
 */
function formatRelationships(node: BaseNode, data: PreparedData): string[] {
  const out: string[] = [];
  const outEdges = data.outgoingEdges.get(node.id) ?? [];
  const inEdges = data.incomingEdges.get(node.id) ?? [];

  // Group outgoing edges by kind
  const calls = outEdges.filter(e => e.kind === 'CALLS').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const extends_ = outEdges.filter(e => e.kind === 'EXTENDS').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const implements_ = outEdges.filter(e => e.kind === 'IMPLEMENTS').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const usesTypes = outEdges.filter(e => e.kind === 'USES_TYPE').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const instantiates = outEdges.filter(e => e.kind === 'INSTANTIATES').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const imports = outEdges.filter(e => e.kind === 'IMPORTS').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];
  const readsConfig = outEdges.filter(e => e.kind === 'READS_CONFIG').map(e => resolveNode(e.toId, data)).filter(Boolean) as BaseNode[];

  // Group incoming edges by kind
  const calledBy = inEdges.filter(e => e.kind === 'CALLS').map(e => resolveNode(e.fromId, data)).filter(Boolean) as BaseNode[];
  const usedBy = inEdges.filter(e => e.kind === 'USES_TYPE' || e.kind === 'INSTANTIATES').map(e => resolveNode(e.fromId, data)).filter(Boolean) as BaseNode[];
  const decoratedBy = inEdges.filter(e => e.kind === 'DECORATES').map(e => resolveNode(e.fromId, data)).filter(Boolean) as BaseNode[];
  const containedIn = inEdges.filter(e => e.kind === 'CONTAINS').map(e => resolveNode(e.fromId, data)).filter(Boolean) as BaseNode[];

  const rels: [string, BaseNode[]][] = [
    ['Calls', calls],
    ['Called by', calledBy],
    ['Extends', extends_],
    ['Implements', implements_],
    ['Uses types', usesTypes],
    ['Instantiates', instantiates],
    ['Used by', usedBy],
    ['Imports', imports],
    ['Reads config', readsConfig],
    ['Decorated by', decoratedBy],
    ['Contained in', containedIn],
  ];

  for (const [label, nodes] of rels) {
    if (nodes.length === 0) continue;
    // Deduplicate by node id
    const seen = new Set<string>();
    const unique = nodes.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
    const links = unique.slice(0, 15).map(n => nodeLink(n, data)).join(', ');
    const more = unique.length > 15 ? `, _+${unique.length - 15} more_` : '';
    out.push(`- **${label}:** ${links}${more}`);
  }

  return out;
}

/** Detect the language for a source snippet from the file extension. */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.java') return 'java';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (ext === '.rb') return 'ruby';
  if (ext === '.cs') return 'csharp';
  if (ext === '.php') return 'php';
  return '';
}

/**
 * Build a full entity detail card: signature, metadata, relationships,
 * optional source snippet, and description.
 */
function formatEntityCard(
  node: BaseNode,
  data: PreparedData,
  includeSnippet: boolean,
): string[] {
  const out: string[] = [];
  const meta = parseMeta(node);
  const anchor = nodeAnchorId(node);

  out.push(`#### \`${node.name}\` {#${anchor}`);
  out.push('');

  // Signature
  const sig = formatSignature(node, meta);
  if (sig && sig !== node.name) {
    out.push('```' + detectLanguage(node.filePath));
    out.push(sig);
    out.push('```');
    out.push('');
  }

  // Metadata badges
  const badges: string[] = [];
  if (meta.isAsync) badges.push('async');
  if (meta.isStatic) badges.push('static');
  if (meta.isExported) badges.push('exported');
  if (meta.isAbstract) badges.push('abstract');
  if (meta.visibility && meta.visibility !== 'public') badges.push(meta.visibility);
  if (meta.decorators?.length) badges.push(`@${meta.decorators.join(' @')}`);
  if (meta.paramCount !== undefined) badges.push(`${meta.paramCount} param${meta.paramCount === 1 ? '' : 's'}`);
  if (meta.returnType) badges.push(`→ ${meta.returnType}`);
  if (meta.propertyCount !== undefined) badges.push(`${meta.propertyCount} propert${meta.propertyCount === 1 ? 'y' : 'ies'}`);
  if (meta.methodCount !== undefined) badges.push(`${meta.methodCount} method${meta.methodCount === 1 ? '' : 's'}`);
  if (meta.members?.length) badges.push(`${meta.members.length} member${meta.members.length === 1 ? '' : 's'}`);

  out.push(`- **Kind:** ${node.kind}`);
  out.push(`- **Qualified name:** \`${node.qualifiedName}\``);
  out.push(`- **Location:** \`${node.filePath}:${node.startLine}${node.endLine > node.startLine ? `-${node.endLine}` : ''}\``);
  if (badges.length > 0) {
    out.push(`- **Attributes:** ${badges.map(b => `\`${b}\``).join(' · ')}`);
  }
  if (node.description && node.description !== `${node.kind} ${node.name}`) {
    out.push(`- **Description:** ${node.description}`);
  }

  // Enum members
  if (meta.members?.length) {
    out.push('');
    out.push('**Members:**');
    for (const m of meta.members) {
      out.push(`- \`${m}\``);
    }
  }

  // Relationships
  const rels = formatRelationships(node, data);
  if (rels.length > 0) {
    out.push('');
    out.push('**Relationships:**');
    out.push(...rels);
  }

  // Source snippet
  if (includeSnippet) {
    const snippet = readSourceSnippet(
      data.fsCtx.repoRoot,
      node.filePath,
      node.startLine,
      node.endLine,
      15,
    );
    const formatted = formatSnippet(snippet, detectLanguage(node.filePath));
    if (formatted) {
      out.push('');
      out.push('**Source:**');
      out.push('');
      out.push(formatted);
    }
  }

  out.push('');
  return out;
}

// ── Business / Functional helpers ─────────────────────────────────────

/** True for test files, spec files, e2e suites, fixtures, and test configs. */
function isTestPath(filePath: string): boolean {
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  return /\.(spec|test)\.[jt]sx?$/.test(norm)
    || norm.includes('/e2e/') || norm.includes('/e2e-live/')
    || norm.includes('__tests__') || norm.includes('__mocks__')
    || norm.includes('/fixtures') || norm.includes('/test-utils')
    || /(playwright|vitest|jest|cypress)(\.[\w-]+)*\.config\.[jt]s$/.test(norm);
}

/** Heuristically categorize modules into business domains based on their paths */
function categorizeBusinessDomain(filePath: string): string {
  const norm = filePath.toLowerCase().replace(/\\/g, '/');
  // Test classification first — spec files in "ui" or "api" folders must not
  // inflate those domains.
  if (isTestPath(filePath)) return 'Testing & Quality Assurance';
  // Short keywords (ai, ui, db, api, pay) match on token boundaries only —
  // otherwise "personaIcon" or "tailwind" would land in the AI domain.
  const tokens = norm.split(/[^a-z0-9]+/);
  const tok = (k: string) => tokens.includes(k);
  const sub = (k: string) => norm.includes(k);
  if (sub('connector') || sub('integration') || tok('mcp')) return 'External Integrations & Connectors';
  if (sub('automation') || sub('schedul') || tok('cron')) return 'Automation & Scheduling';
  if (sub('inbox') || sub('notification') || sub('email')) return 'Messaging & Notifications';
  if (sub('approv') || sub('permission') || sub('audit') || sub('govern')) return 'Approvals, Governance & Audit';
  if (sub('auth') || sub('login') || tok('jwt') || sub('oauth') || tok('user') || tok('users')) return 'User & Authentication';
  if (tok('pay') || sub('payment') || sub('bill') || sub('invoice') || sub('order') || sub('subscription')) return 'Order, Payment & Billing';
  if (tok('api') || sub('server') || sub('router') || sub('endpoint')) return 'API & Backend Services';
  if (sub('graph') || sub('kuzu') || tok('db') || sub('database') || sub('store') || sub('persist')) return 'Data Layer & Storage';
  if (sub('search') || sub('query')) return 'Search & Query Engine';
  if (sub('docs') || sub('generator') || sub('report')) return 'Documentation & Reporting';
  if (sub('llm') || tok('ai') || sub('prompt') || sub('ollama') || sub('anthropic') || sub('openai')) return 'AI & LLM Integration';
  if (tok('ui') || tok('gui') || sub('component') || sub('frontend') || sub('view') || tok('page') || tok('screen')) return 'User Interface & Frontend';
  return 'General Core & Utilities';
}

/** Business-readable purpose per domain. */
function domainPurpose(domain: string): string {
  const purposes: Record<string, string> = {
    'User & Authentication': 'Manages user accounts, sign-in, and access controls',
    'Order, Payment & Billing': 'Handles payment flows, billing cycles, and order state management',
    'API & Backend Services': 'Exposes core services and handles incoming client requests',
    'Data Layer & Storage': 'Persists, caches, and retrieves application data',
    'Search & Query Engine': 'Provides search, indexing, and data retrieval capabilities',
    'User Interface & Frontend': 'Manages the presentation layer and user-facing workflows',
    'Documentation & Reporting': 'Generates technical/business reports and project artifacts',
    'AI & LLM Integration': 'Integrates with language models for code generation and query answering',
    'External Integrations & Connectors': 'Connects the product to third-party services and external systems',
    'Automation & Scheduling': 'Runs recurring and event-driven background work',
    'Messaging & Notifications': 'Handles inbox triage, notifications, and message delivery',
    'Approvals, Governance & Audit': 'Enforces approval gates and records auditable activity',
    'Testing & Quality Assurance': 'Automated test coverage for the product surface',
  };
  return purposes[domain] ?? 'Provides shared utilities, config helpers, and core runtime logic';
}

/**
 * Extract a clean prose excerpt from a README: strips HTML tags, badge
 * images, link-only lines, and decorative noise; keeps the first real
 * heading and the paragraphs/bullet lists that follow.
 */
function cleanReadmeExcerpt(readme: string, maxLines = 40): string {
  const out: string[] = [];
  let inHtmlBlock = false;

  for (const raw of readme.split('\n')) {
    const line = raw.trim();

    // Skip HTML comments entirely (may span multiple lines)
    if (line.includes('<!--')) inHtmlBlock = true;
    if (inHtmlBlock) {
      if (line.includes('-->')) inHtmlBlock = false;
      continue;
    }

    // Skip lines that are pure HTML, badges, images, or alignment wrappers
    if (/^<\/?(p|h\d|div|img|a|picture|source|br|table|tr|td|th|details|summary)\b/i.test(line)) continue;
    if (/^\[!\[/.test(line)) continue;                    // badge links [![..](..)](..)
    if (/^!\[/.test(line)) continue;                     // bare images
    if (/^<img\b/i.test(line)) continue;

    // Stop at the first second-level heading after we have content —
    // the intro ends there
    if (/^##\s/.test(line) && out.length > 0) break;

    // Convert residual inline HTML to markdown-ish text
    const cleaned = line
      .replace(/<\/?(strong|b)>/gi, '**')
      .replace(/<\/?(em|i)>/gi, '*')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (cleaned || out.length > 0) out.push(cleaned);
    if (out.length >= maxLines) { out.push('', '_…_'); break; }
  }

  // Trim leading/trailing blank lines
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Detect third-party service integrations from module paths, package names,
 * and dependencies. Returns display names like "Slack", "GitHub", "Ollama".
 */
function detectIntegrations(data: PreparedData): string[] {
  const services: [RegExp, string][] = [
    [/slack/i, 'Slack'], [/gmail/i, 'Gmail'], [/gcal|google[-_]?calendar|google/i, 'Google (Calendar/Workspace)'],
    [/github/i, 'GitHub'], [/gitlab/i, 'GitLab'], [/hubspot/i, 'HubSpot'],
    [/salesforce/i, 'Salesforce'], [/jira/i, 'Jira'], [/linear/i, 'Linear'],
    [/notion/i, 'Notion'], [/outlook/i, 'Outlook'], [/teams/i, 'Microsoft Teams'],
    [/zoom/i, 'Zoom'], [/discord/i, 'Discord'], [/twilio/i, 'Twilio'],
    [/sendgrid/i, 'SendGrid'], [/stripe/i, 'Stripe'], [/shopify/i, 'Shopify'],
    [/sentry/i, 'Sentry'], [/datadog/i, 'Datadog'], [/ollama/i, 'Ollama'],
    [/openai/i, 'OpenAI'], [/anthropic/i, 'Anthropic'], [/bedrock/i, 'AWS Bedrock'],
    [/omniroute/i, 'Omniroute'], [/postgres|pg/i, 'PostgreSQL'], [/mysql/i, 'MySQL'],
    [/redis/i, 'Redis'], [/mongodb|mongo/i, 'MongoDB'], [/kuzu/i, 'KuzuDB'],
    [/playwright/i, 'Playwright'], [/tauri/i, 'Tauri'], [/electron/i, 'Electron'],
    [/\bmcp\b|model-context-protocol/i, 'MCP (Model Context Protocol)'],
  ];

  const haystacks: string[] = [];
  for (const mod of data.nodesByKind.get('Module') ?? []) {
    if (!isTestPath(mod.filePath)) haystacks.push(mod.filePath);
  }
  for (const pkg of data.packages) haystacks.push(pkg.name);
  for (const dep of Object.keys(data.fsCtx.rootPackageJson?.dependencies ?? {})) haystacks.push(dep);
  for (const dep of Object.keys(data.fsCtx.rootPackageJson?.devDependencies ?? {})) haystacks.push(dep);

  const found = new Set<string>();
  for (const [re, name] of services) {
    if (haystacks.some(h => re.test(h))) found.add(name);
  }
  return Array.from(found).sort();
}

/** Sort modules by connectivity (most incoming edges first) — the important ones. */
function sortByConnectivity(mods: BaseNode[], data: PreparedData): BaseNode[] {
  return [...mods].sort((a, b) =>
    (data.incomingEdges.get(b.id)?.length ?? 0) - (data.incomingEdges.get(a.id)?.length ?? 0)
    || a.filePath.localeCompare(b.filePath));
}

/** True when an APIEndpoint node looks like a real route, not a parsed parameter/test artifact. */
function isRealEndpoint(node: BaseNode): boolean {
  if (isTestPath(node.filePath)) return false;
  const meta = parseMeta(node);
  if (typeof meta.path === 'string' && meta.path.startsWith('/')) return true;
  // Fall back to the node name pattern "GET /some/path"
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//.test(node.name);
}

/** Build a Business / Functional Markdown section */
function buildBusinessSection(data: PreparedData, repoName: string, llmNarratives?: Map<string, string>): string[] {
  const lines: string[] = [];
  const DOMAIN_DETAIL_CAP = 12;
  lines.push('## Business & Functional Overview');
  lines.push('');
  lines.push('This section describes the system in business terms: what it does, ' +
    'the functional capabilities it provides, how users and external systems ' +
    'interact with it, and where those capabilities live in the codebase.');
  lines.push('');

  // ── What it does (cleaned README excerpt or package description) ──
  const readmeExcerpt = data.fsCtx.readme ? cleanReadmeExcerpt(data.fsCtx.readme) : '';
  if (readmeExcerpt) {
    lines.push(`### What ${repoName} Does`);
    lines.push('');
    lines.push(readmeExcerpt);
    lines.push('');
  } else if (data.fsCtx.rootPackageJson?.description) {
    lines.push(`### What ${repoName} Does`);
    lines.push('');
    lines.push(`> ${data.fsCtx.rootPackageJson.description}`);
    lines.push('');
  }

  // ── Functional capabilities (domain grouping, test files excluded) ──
  const domains = new Map<string, BaseNode[]>();
  const modules = data.nodesByKind.get('Module') ?? [];
  let testModuleCount = 0;
  for (const mod of modules) {
    const domain = categorizeBusinessDomain(mod.filePath);
    if (domain === 'Testing & Quality Assurance') { testModuleCount++; continue; }
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain)!.push(mod);
  }

  const sortedDomains = Array.from(domains.entries()).sort((a, b) => b[1].length - a[1].length);

  lines.push('### Functional Capabilities');
  lines.push('');
  if (sortedDomains.length === 0) {
    lines.push('_No functional domains were detected._');
    lines.push('');
  } else {
    lines.push('| Capability Area | What It Enables | Modules | Key Components |');
    lines.push('|-----------------|-----------------|---------|----------------|');
    for (const [domain, mods] of sortedDomains) {
      const top = sortByConnectivity(mods, data).slice(0, 3)
        .map(m => `\`${m.filePath.split(/[\/\\]/).pop()}\``).join(', ');
      lines.push(`| **${domain}** | ${domainPurpose(domain)} | ${mods.length} | ${top} |`);
    }
    lines.push('');
    if (testModuleCount > 0) {
      lines.push(`_The codebase also contains **${testModuleCount} test/spec file${testModuleCount === 1 ? '' : 's'}**` +
        `${data.fsCtx.testFramework ? ` (${data.fsCtx.testFramework})` : ''}, providing coverage across the areas above._`);
      lines.push('');
    }
  }

  // ── Capability details (capped, most-connected modules first) ──
  if (sortedDomains.length > 0) {
    lines.push('### Capability Details');
    lines.push('');
    for (const [domain, mods] of sortedDomains) {
      const ranked = sortByConnectivity(mods, data);
      const shown = ranked.slice(0, DOMAIN_DETAIL_CAP);
      lines.push(`<details>`);
      lines.push(`<summary><strong>${domain}</strong> — ${mods.length} module${mods.length === 1 ? '' : 's'}</summary>`);
      lines.push('');
      if (llmNarratives?.has(domain)) {
        lines.push(`> ${llmNarratives.get(domain)}`);
        lines.push('');
      }
      lines.push('| Module | Location |');
      lines.push('|--------|----------|');
      for (const mod of shown) {
        lines.push(`| \`${mod.name}\` | \`${mod.filePath}\` |`);
      }
      if (mods.length > DOMAIN_DETAIL_CAP) {
        lines.push(`| _…and ${mods.length - DOMAIN_DETAIL_CAP} more modules_ | |`);
      }
      lines.push('');
      lines.push(`</details>`);
      lines.push('');
    }
  }

  // ── Entry Points & User Workflows ──
  const entryPoints = detectEntryPoints(data);
  if (entryPoints.length > 0) {
    lines.push('### User-Facing Entry Points');
    lines.push('');
    lines.push('The following interfaces are where users or external systems interact with the product:');
    lines.push('');
    lines.push('| Entry Point | Type | Location |');
    lines.push('|-------------|------|----------|');
    for (const ep of entryPoints.slice(0, 25)) {
      lines.push(`| \`${ep.node.name}\` | ${ep.entryType} | \`${ep.node.filePath}:${ep.node.startLine}\` |`);
    }
    lines.push('');

    // Trace workflows from each entry point — emit heading only if a trace exists
    const traces: { ep: (typeof entryPoints)[0]; trace: string[] }[] = [];
    for (const ep of entryPoints.slice(0, 5)) {
      const trace = traceWorkflow(ep, data, 3);
      if (trace.length > 0) traces.push({ ep, trace });
    }
    if (traces.length > 0) {
      lines.push('#### Core Workflows');
      lines.push('');
      for (const { ep, trace } of traces) {
        lines.push(`**From \`${ep.node.name}\` (${ep.entryType}):**`);
        lines.push('');
        lines.push('```mermaid');
        lines.push('graph LR');
        lines.push(...trace);
        lines.push('```');
        lines.push('');
      }
    }
  }

  // ── External Integrations & Touchpoints ──
  lines.push('### External Integrations & Touchpoints');
  lines.push('');

  // Detected third-party services (from module paths + dependency names)
  const integrations = detectIntegrations(data);
  if (integrations.length > 0) {
    lines.push('**Detected integrations:** ' + integrations.map(i => `\`${i}\``).join(', '));
    lines.push('');
  }

  const configs = data.nodesByKind.get('Config') ?? [];
  const pkgs = data.packages;

  // External packages with usage info
  if (pkgs.length > 0) {
    lines.push('**External Packages & Dependencies:**');
    lines.push('');
    lines.push('| Package | Version | Used By (modules) |');
    lines.push('|---------|---------|-------------------|');
    for (const pkg of pkgs.slice(0, 30)) {
      const meta = parseMeta(pkg);
      const version = meta.version || '—';
      // Find modules that depend on this package
      const dependents = (data.incomingEdges.get(pkg.id) ?? [])
        .filter(e => e.kind === 'DEPENDS_ON')
        .map(e => resolveNode(e.fromId, data))
        .filter(Boolean) as BaseNode[];
      const usedBy = dependents.length > 0
        ? dependents.slice(0, 5).map(d => `\`${d.name}\``).join(', ') + (dependents.length > 5 ? `, _+${dependents.length - 5}_` : '')
        : '—';
      lines.push(`| \`${pkg.name}\` | ${version} | ${usedBy} |`);
    }
    lines.push('');
  } else {
    lines.push('- **External Packages:** None detected in the graph.');
    lines.push('');
  }

  // Configuration files
  if (configs.length > 0) {
    lines.push('**Configuration Files:**');
    lines.push('');
    for (const c of configs) {
      lines.push(`- \`${c.filePath}\`${c.description ? ` — ${c.description}` : ''}`);
    }
    lines.push('');
  }

  // Environment variables
  if (data.fsCtx.envExample.length > 0) {
    lines.push(`**Environment Variables:** ${data.fsCtx.envExample.length} variable${data.fsCtx.envExample.length === 1 ? '' : 's'} defined in \`.env.example\` (see [Developer Guide](#developer-guide--setup) for details).`);
    lines.push('');
  }

  // License
  if (data.fsCtx.licenseType) {
    lines.push(`**License:** ${data.fsCtx.licenseType}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  return lines;
}

/**
 * Detect entry points using multiple signals:
 *  - API endpoints (EXPOSES edges)
 *  - Exported functions named main/start/index/bootstrap/run
 *  - package.json bin entries and main field
 *  - CLI command definitions
 */
function detectEntryPoints(data: PreparedData): { node: BaseNode; entryType: string }[] {
  const results: { node: BaseNode; entryType: string }[] = [];
  const seen = new Set<string>();

  // API endpoints — real routes only (test files and misparsed artifacts
  // like "GET q" from fixtures are filtered out)
  for (const ep of data.endpoints) {
    if (!isRealEndpoint(ep) || seen.has(ep.id)) continue;
    seen.add(ep.id);
    results.push({ node: ep, entryType: 'API Endpoint' });
  }

  // Exported functions with common entry-point names (non-test files only)
  const entryNames = ['main', 'start', 'index', 'bootstrap', 'run', 'init', 'launch', 'serve', 'listen', 'createApp', 'createServer'];
  const fns = [...(data.nodesByKind.get('Function') ?? []), ...(data.nodesByKind.get('Method') ?? [])];
  for (const fn of fns) {
    if (isTestPath(fn.filePath)) continue;
    if (entryNames.includes(fn.name.toLowerCase()) && !seen.has(fn.id)) {
      const meta = parseMeta(fn);
      if (meta.isExported || fn.name === 'main') {
        seen.add(fn.id);
        results.push({ node: fn, entryType: 'Entry Function' });
      }
    }
  }

  // package.json bin / main
  if (data.fsCtx.rootPackageJson) {
    const pkg = data.fsCtx.rootPackageJson;
    if (pkg.main) {
      const mainModule = (data.nodesByKind.get('Module') ?? []).find(m =>
        m.filePath.endsWith(pkg.main!) || m.filePath === pkg.main
      );
      if (mainModule && !seen.has(mainModule.id)) {
        seen.add(mainModule.id);
        results.push({ node: mainModule, entryType: 'Package Main' });
      }
    }
    if (pkg.bin) {
      const bins = typeof pkg.bin === 'string' ? { [pkg.name ?? 'app']: pkg.bin } : pkg.bin;
      for (const [binName, binPath] of Object.entries(bins)) {
        const binModule = (data.nodesByKind.get('Module') ?? []).find(m =>
          m.filePath.endsWith(binPath) || m.filePath === binPath
        );
        if (binModule && !seen.has(binModule.id)) {
          seen.add(binModule.id);
          results.push({ node: binModule, entryType: `CLI: ${binName}` });
        }
      }
    }
  }

  return results;
}

/**
 * Trace a workflow from an entry point through the call graph (up to maxDepth hops).
 * Returns Mermaid graph lines showing the call chain.
 */
function traceWorkflow(entry: { node: BaseNode; entryType: string }, data: PreparedData, maxDepth: number): string[] {
  const lines: string[] = [];
  const visited = new Set<string>();
  const safeId = (id: string) => 'n' + id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);

  function walk(node: BaseNode, depth: number) {
    if (depth >= maxDepth || visited.has(node.id)) return;
    visited.add(node.id);
    const outEdges = data.outgoingEdges.get(node.id) ?? [];
    const calls = outEdges
      .filter(e => e.kind === 'CALLS' || e.kind === 'INSTANTIATES')
      .map(e => resolveNode(e.toId, data))
      .filter(Boolean) as BaseNode[];
    for (const callee of calls.slice(0, 5)) {
      const fromSafe = safeId(node.id);
      const toSafe = safeId(callee.id);
      lines.push(`  ${fromSafe}["${node.name.replace(/"/g, "'")}"] --> ${toSafe}["${callee.name.replace(/"/g, "'")}"]`);
      walk(callee, depth + 1);
    }
  }

  walk(entry.node, 0);
  return lines;
}

/** Build Mermaid diagram for System Architecture & Dependencies */
function buildMermaidDiagram(data: PreparedData): string[] {
  const lines: string[] = [];
  lines.push('### System Architecture Diagram');
  lines.push('');
  lines.push('The following Mermaid diagram shows high-level inter-module dependencies and code flows:');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');

  // Create a map for sanitized node names (safe for Mermaid)
  const idMap = new Map<string, string>();
  const allModules = data.nodesByKind.get('Module') ?? [];
  for (const mod of allModules) {
    idMap.set(mod.id, `mod_${mod.id.replace(/[^a-zA-Z0-9]/g, '_')}`);
  }

  // Add Module nodes
  for (const mod of allModules) {
    const safeName = mod.name.replace(/[^a-zA-Z0-9 .\/_-]/g, '');
    lines.push(`  ${idMap.get(mod.id)}["${safeName}"]`);
  }

  // Add Edges (Imports / Depends_On)
  const depEdges = data.allEdges.filter(e => e.kind === 'IMPORTS' || e.kind === 'DEPENDS_ON');
  const uniqueDepEdges = new Set<string>();

  for (const edge of depEdges) {
    const fromId = idMap.get(edge.fromId);
    const toId = idMap.get(edge.toId);
    if (fromId && toId && fromId !== toId) {
      const edgeKey = `${fromId}->${toId}`;
      if (!uniqueDepEdges.has(edgeKey)) {
        uniqueDepEdges.add(edgeKey);
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }

  // Add Architecture Pattern / API Endpoint subgroups if needed (optional, simplified)
  lines.push('```');
  lines.push('');
  return lines;
}

/** Build Inheritance Hierarchy Mermaid Diagram */
function buildInheritanceDiagram(data: PreparedData): string[] {
  const lines: string[] = [];
  const extendsEdges = data.edgesByKind.get('EXTENDS') ?? [];
  const implementsEdges = data.edgesByKind.get('IMPLEMENTS') ?? [];

  if (extendsEdges.length === 0 && implementsEdges.length === 0) return [];

  lines.push('### Inheritance Hierarchy Diagram');
  lines.push('');
  lines.push('```mermaid');
  lines.push('classDiagram');

  const idMap = new Map<string, string>();
  const classes = data.nodesByKind.get('Class') ?? [];
  const interfaces = data.nodesByKind.get('Interface') ?? [];

  for (const cls of classes) {
    idMap.set(cls.id, cls.name.replace(/[^a-zA-Z0-9]/g, '_'));
  }
  for (const inf of interfaces) {
    idMap.set(inf.id, inf.name.replace(/[^a-zA-Z0-9]/g, '_'));
  }

  for (const edge of extendsEdges) {
    const fromName = idMap.get(edge.fromId);
    const toName = idMap.get(edge.toId);
    if (fromName && toName) {
      lines.push(`  ${toName} <|-- ${fromName} : extends`);
    }
  }

  for (const edge of implementsEdges) {
    const fromName = idMap.get(edge.fromId);
    const toName = idMap.get(edge.toId);
    if (fromName && toName) {
      lines.push(`  ${toName} <|.. ${fromName} : implements`);
    }
  }

  lines.push('```');
  lines.push('');
  return lines;
}

// ── Architecture helpers ─────────────────────────────────────────────

/** Build a layered architecture narrative from domain grouping + import edges. */
function buildLayeredNarrative(data: PreparedData): string[] {
  const lines: string[] = [];
  const modules = data.nodesByKind.get('Module') ?? [];

  // Map each module to its business domain
  const moduleDomain = new Map<string, string>();
  const domains = new Map<string, BaseNode[]>();
  for (const mod of modules) {
    const domain = categorizeBusinessDomain(mod.filePath);
    moduleDomain.set(mod.id, domain);
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain)!.push(mod);
  }

  // Count cross-domain imports to determine layer dependencies
  const domainDeps = new Map<string, Map<string, number>>();
  const importEdges = data.edgesByKind.get('IMPORTS') ?? [];
  for (const edge of importEdges) {
    const fromDomain = moduleDomain.get(edge.fromId);
    const toDomain = moduleDomain.get(edge.toId);
    if (fromDomain && toDomain && fromDomain !== toDomain) {
      if (!domainDeps.has(fromDomain)) domainDeps.set(fromDomain, new Map());
      const deps = domainDeps.get(fromDomain)!;
      deps.set(toDomain, (deps.get(toDomain) ?? 0) + 1);
    }
  }

  // Identify layers (simplified: entry/UI → API → data/core)
  const layerOrder = [
    'User Interface & Frontend',
    'API & Backend Services',
    'AI & LLM Integration',
    'Search & Query Engine',
    'Data Layer & Graph Storage',
    'Documentation & Reporting',
    'Testing & Quality Assurance',
    'User & Authentication',
    'Order, Payment & Billing',
    'General Core & Utilities',
  ];

  lines.push('The system follows a layered architecture. Based on import analysis, ' +
    'the following dependency flow was observed between business domains:');
  lines.push('');

  // Mermaid diagram of domain dependencies
  lines.push('```mermaid');
  lines.push('graph TD');
  const domainIdMap = new Map<string, string>();
  let domainIdx = 0;
  for (const [domain] of domains) {
    const safeId = `D${domainIdx++}`;
    domainIdMap.set(domain, safeId);
    lines.push(`  ${safeId}["${domain}"]`);
  }
  for (const [fromDomain, deps] of domainDeps) {
    const fromId = domainIdMap.get(fromDomain);
    if (!fromId) continue;
    for (const [toDomain, count] of deps) {
      const toId = domainIdMap.get(toDomain);
      if (toId) {
        lines.push(`  ${fromId} -->|${count}| ${toId}`);
      }
    }
  }
  lines.push('```');
  lines.push('');

  // Narrative description of each layer
  lines.push('| Layer (Domain) | Module Count | Depends On |');
  lines.push('|----------------|-------------|------------|');
  for (const domain of layerOrder) {
    const mods = domains.get(domain);
    if (!mods || mods.length === 0) continue;
    const deps = domainDeps.get(domain);
    const depList = deps
      ? Array.from(deps.entries()).sort((a, b) => b[1] - a[1]).map(([d, c]) => `\`${d}\` (${c})`).join(', ')
      : '— (base layer)';
    lines.push(`| ${domain} | ${mods.length} | ${depList} |`);
  }
  lines.push('');

  return lines;
}

/** Build a call-graph hotspot table — most-called functions/methods. */
function buildCallGraphHotspots(data: PreparedData, topN: number = 15): string[] {
  const lines: string[] = [];
  const callsEdges = data.edgesByKind.get('CALLS') ?? [];

  // Count incoming CALLS per target node
  const callCounts = new Map<string, number>();
  for (const edge of callsEdges) {
    callCounts.set(edge.toId, (callCounts.get(edge.toId) ?? 0) + 1);
  }

  const hotspots = Array.from(callCounts.entries())
    .map(([id, count]) => ({ node: resolveNode(id, data), count }))
    .filter(h => h.node && (h.node.kind === 'Function' || h.node.kind === 'Method'))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  if (hotspots.length === 0) {
    lines.push('_No call relationships were detected in the graph._');
    lines.push('');
    return lines;
  }

  lines.push('| Rank | Function / Method | Kind | Location | Incoming Calls |');
  lines.push('|------|-------------------|------|----------|----------------|');
  for (let i = 0; i < hotspots.length; i++) {
    const h = hotspots[i];
    lines.push(`| ${i + 1} | ${nodeLink(h.node!, data)} | ${h.node!.kind} | \`${h.node!.filePath}:${h.node!.startLine}\` | ${h.count} |`);
  }
  lines.push('');
  lines.push('_These are the most heavily depended-upon functions in the codebase. ' +
    'Changes to them have the widest blast radius — see the Impact Analysis tab for details._');
  lines.push('');
  return lines;
}

/** Build a pattern-to-module mapping using FOLLOWS_PATTERN edges. */
function buildPatternModuleMapping(data: PreparedData): string[] {
  const lines: string[] = [];
  const followsEdges = data.edgesByKind.get('FOLLOWS_PATTERN') ?? [];

  for (const p of data.patterns) {
    const meta = parseMeta(p);
    const signals = meta.signals ? meta.signals.join(', ') : 'N/A';
    const followers = followsEdges
      .filter(e => e.toId === p.id)
      .map(e => ({ node: resolveNode(e.fromId, data), weight: e.weight }))
      .filter(f => f.node) as { node: BaseNode; weight: number }[];

    lines.push(`#### ${p.name}`);
    lines.push('');
    lines.push(`- **ID:** \`${p.id}\``);
    lines.push(`- **Detection signals:** ${signals}`);
    lines.push(`- **Description:** ${p.description}`);
    if (followers.length > 0) {
      lines.push(`- **Modules following this pattern:** ${followers.length}`);
      lines.push('');
      lines.push('| Module | Confidence |');
      lines.push('|--------|------------|');
      for (const f of followers.sort((a, b) => b.weight - a.weight).slice(0, 10)) {
        const pct = Math.round(f.weight * 100);
        lines.push(`| ${nodeLink(f.node, data)} | ${pct}% |`);
      }
      lines.push('');
    } else {
      lines.push('- **Modules following this pattern:** _None detected_');
      lines.push('');
    }
  }
  return lines;
}

/** Build a deployment view from Docker/compose files. */
function buildDeploymentView(data: PreparedData): string[] {
  const lines: string[] = [];
  const ctx = data.fsCtx;

  if (!ctx.dockerCompose && !ctx.dockerfile) {
    lines.push('_No Docker or docker-compose configuration was detected. ' +
      'Deployment appears to be handled via direct process execution (see Setup & Commands above)._');
    lines.push('');
    return lines;
  }

  if (ctx.dockerfile) {
    lines.push('### Dockerfile');
    lines.push('');
    lines.push('A `Dockerfile` is present in the repository. Key stages:');
    lines.push('');
    // Extract key Dockerfile instructions
    const dockerLines = ctx.dockerfile.split('\n');
    const keyInstructions = dockerLines.filter(l =>
      /^(FROM|RUN|COPY|CMD|ENTRYPOINT|EXPOSE|ENV|WORKDIR|LABEL)\s/i.test(l.trim())
    );
    for (const inst of keyInstructions.slice(0, 20)) {
      lines.push(`- \`${inst.trim()}\``);
    }
    lines.push('');
  }

  if (ctx.dockerCompose) {
    lines.push('### Docker Compose');
    lines.push('');
    lines.push('A `docker-compose` file is present. Detected services:');
    lines.push('');
    // Extract service names from compose file
    const composeLines = ctx.dockerCompose.split('\n');
    let inServices = false;
    const services: string[] = [];
    for (const line of composeLines) {
      if (/^services:/.test(line.trim())) { inServices = true; continue; }
      if (inServices && /^\S/.test(line) && !line.startsWith('#')) { inServices = false; }
      if (inServices && /^  \w+/.test(line) && !line.startsWith('  #')) {
        const name = line.trim().replace(/:.*$/, '');
        if (name && !['image', 'build', 'ports', 'environment', 'volumes', 'depends_on', 'restart', 'container_name'].includes(name)) {
          services.push(name);
        }
      }
    }
    if (services.length > 0) {
      for (const s of services) {
        lines.push(`- **\`${s}\`**`);
      }
    } else {
      lines.push('_Service definitions detected but could not be parsed automatically. See the compose file for details._');
    }
    lines.push('');
    lines.push('```yaml');
    lines.push(ctx.dockerCompose.split('\n').slice(0, 40).join('\n'));
    if (ctx.dockerCompose.split('\n').length > 40) lines.push('# … (truncated)');
    lines.push('```');
    lines.push('');
  }

  return lines;
}

// ── Developer Guide helpers ──────────────────────────────────────────

/** Build a project structure tree from Module nodes. */
function buildProjectStructureTree(data: PreparedData): string[] {
  const lines: string[] = [];
  const modules = (data.nodesByKind.get('Module') ?? []).sort((a, b) => a.filePath.localeCompare(b.filePath));
  if (modules.length === 0) return lines;

  // Build a tree from file paths
  const tree: Record<string, any> = {};
  for (const mod of modules) {
    const parts = mod.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node[part]) node[part] = {};
      node = node[part];
    }
  }

  function renderTree(t: Record<string, any>, prefix: string, indent: string): void {
    const entries = Object.entries(t).sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < entries.length; i++) {
      const [name, children] = entries[i];
      const isLast = i === entries.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      const hasChildren = Object.keys(children as any).length > 0;
      if (hasChildren) {
        lines.push(`${indent}${marker}**${name}/**`);
        renderTree(children as any, prefix, indent + (isLast ? '    ' : '│   '));
      } else {
        lines.push(`${indent}${marker}\`${name}\``);
      }
    }
  }

  lines.push('```');
  renderTree(tree, '', '');
  lines.push('```');
  lines.push('');
  return lines;
}

/** Build an environment variable table from .env.example. */
function buildEnvVarTable(data: PreparedData): string[] {
  const lines: string[] = [];
  const envVars = data.fsCtx.envExample;
  if (envVars.length === 0) return lines;

  lines.push('| Variable | Default Value | Required | Description |');
  lines.push('|----------|---------------|----------|-------------|');
  for (const v of envVars) {
    const req = v.required ? '✅ Yes' : 'Optional';
    const desc = v.description || '—';
    const def = v.defaultValue || '_(empty)_';
    lines.push(`| \`${v.name}\` | \`${def}\` | ${req} | ${desc} |`);
  }
  lines.push('');
  return lines;
}

/** Build step-by-step setup instructions from package.json + env. */
function buildSetupSteps(data: PreparedData): string[] {
  const lines: string[] = [];
  const pkg = data.fsCtx.rootPackageJson;

  // Prerequisites
  lines.push('### Prerequisites');
  lines.push('');
  if (pkg?.engines?.node) {
    lines.push(`- **Node.js:** ${pkg.engines.node}`);
  } else {
    lines.push('- **Node.js:** v18+ (recommended)');
  }
  lines.push('- **Package Manager:** npm (or yarn/pnpm as preferred)');
  if (data.fsCtx.testFramework) {
    lines.push(`- **Test Framework:** ${data.fsCtx.testFramework}`);
  }
  if (pkg?.engines) {
    for (const [engine, version] of Object.entries(pkg.engines)) {
      if (engine !== 'node') {
        lines.push(`- **${engine}:** ${version}`);
      }
    }
  }
  lines.push('');

  // Setup steps
  lines.push('### Step-by-Step Setup');
  lines.push('');
  lines.push('1. **Clone the repository:**');
  lines.push('   ```bash');
  lines.push('   git clone <repository-url>');
  lines.push('   cd <repo-directory>');
  lines.push('   ```');
  lines.push('');
  lines.push('2. **Install dependencies:**');
  lines.push('   ```bash');
  lines.push('   npm install');
  lines.push('   ```');
  lines.push('');

  // Environment setup
  if (data.fsCtx.envExample.length > 0) {
    lines.push('3. **Configure environment variables:**');
    lines.push('   ```bash');
    lines.push('   cp .env.example .env');
    lines.push('   # Edit .env with your values — see Environment Variables table below');
    lines.push('   ```');
    lines.push('');
  }

  // Build
  const scripts = pkg?.scripts ?? {};
  if (scripts.build) {
    const stepNum = data.fsCtx.envExample.length > 0 ? '4' : '3';
    lines.push(`${stepNum}. **Build the project:**`);
    lines.push('   ```bash');
    lines.push('   npm run build');
    lines.push('   ```');
    lines.push('');
  }

  // Run
  if (scripts.start || scripts.dev) {
    const stepNum = data.fsCtx.envExample.length > 0 ? '5' : '4';
    lines.push(`${stepNum}. **Start the application:**`);
    lines.push('   ```bash');
    lines.push(scripts.dev ? '   npm run dev    # development mode with hot reload' : '   npm start');
    if (scripts.start && scripts.dev) {
      lines.push('   npm start      # production mode');
    }
    lines.push('   ```');
    lines.push('');
  }

  return lines;
}

/** Build Developer Guide Markdown Section (enriched) */
function buildDeveloperGuideSection(data: PreparedData, repoName: string): string[] {
  const lines: string[] = [];
  lines.push('## Developer Guide & Setup');
  lines.push('');
  lines.push('This section provides the practical steps needed to set up, build, ' +
    'test, and deploy the codebase.');
  lines.push('');

  // ── Prerequisites & Setup Steps ──
  lines.push(...buildSetupSteps(data));

  // ── Environment Variables ──
  const envTable = buildEnvVarTable(data);
  if (envTable.length > 0) {
    lines.push('### Environment Variables');
    lines.push('');
    lines.push('The following environment variables are expected by the application:');
    lines.push('');
    lines.push(...envTable);
  }

  // ── Build / Test / Run Commands ──
  lines.push('### Available Commands');
  lines.push('');
  const pkg = data.fsCtx.rootPackageJson;
  const scripts = pkg?.scripts ?? {};
  if (Object.keys(scripts).length > 0) {
    lines.push('| Command | Description | Script |');
    lines.push('|---------|-------------|--------|');
    for (const [name, cmd] of Object.entries(scripts)) {
      const desc = commandDescription(name);
      lines.push(`| \`npm run ${name}\` | ${desc} | \`${cmd}\` |`);
    }
    lines.push('');
  } else {
    // Fallback to graph-stored package data
    const graphPkgs = data.packages;
    for (const gpkg of graphPkgs) {
      const meta = parseMeta(gpkg);
      if (meta.scripts) {
        const scriptsObj = Array.isArray(meta.scripts)
          ? Object.fromEntries(meta.scripts.map((s: string) => [s, '']))
          : meta.scripts;
        lines.push(`**Package: \`${gpkg.name}\`**`);
        lines.push('');
        for (const [name, cmd] of Object.entries(scriptsObj) as [string, string][]) {
          lines.push(cmd ? `- \`npm run ${name}\` → \`${cmd}\`` : `- \`npm run ${name}\``);
        }
        lines.push('');
      }
    }
  }

  // ── Project Structure ──
  lines.push('### Project Structure');
  lines.push('');
  lines.push('The following directory structure was derived from the indexed modules:');
  lines.push('');
  lines.push(...buildProjectStructureTree(data));

  // ── Key Dependencies & Toolchain ──
  lines.push('### Key Dependencies & Toolchain');
  lines.push('');
  if (pkg) {
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      lines.push('**Production Dependencies:**');
      lines.push('');
      lines.push('| Package | Version |');
      lines.push('|---------|---------|');
      for (const [dep, ver] of Object.entries(pkg.dependencies)) {
        lines.push(`| \`${dep}\` | \`${ver}\` |`);
      }
      lines.push('');
    }
    if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
      lines.push('**Development Dependencies:**');
      lines.push('');
      lines.push('| Package | Version |');
      lines.push('|---------|---------|');
      for (const [dep, ver] of Object.entries(pkg.devDependencies)) {
        lines.push(`| \`${dep}\` | \`${ver}\` |`);
      }
      lines.push('');
    }
    if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
      lines.push('**Peer Dependencies:**');
      lines.push('');
      for (const [dep, ver] of Object.entries(pkg.peerDependencies)) {
        lines.push(`- \`${dep}\`: \`${ver}\``);
      }
      lines.push('');
    }
  }

  // Toolchain config
  if (data.fsCtx.tsconfig) {
    lines.push('**TypeScript Configuration:**');
    lines.push('');
    const ts = data.fsCtx.tsconfig;
    const tc = ts.compilerOptions || {};
    const keyTsConfig: [string, string][] = [
      ['Target', tc.target],
      ['Module', tc.module],
      ['Module Resolution', tc.moduleResolution],
      ['Strict', tc.strict !== undefined ? String(tc.strict) : undefined],
      ['Out Dir', tc.outDir],
      ['Source Map', tc.sourceMap !== undefined ? String(tc.sourceMap) : undefined],
      ['JSX', tc.jsx],
      ['ES Module Interop', tc.esModuleInterop !== undefined ? String(tc.esModuleInterop) : undefined],
    ].filter(([, v]) => v !== undefined) as [string, string][];
    if (keyTsConfig.length > 0) {
      lines.push('| Setting | Value |');
      lines.push('|---------|-------|');
      for (const [k, v] of keyTsConfig) {
        lines.push(`| ${k} | \`${v}\` |`);
      }
      lines.push('');
    }
  }

  // ── Testing ──
  if (data.fsCtx.hasTests) {
    lines.push('### Testing');
    lines.push('');
    lines.push(`This project uses **${data.fsCtx.testFramework}** for testing.`);
    lines.push('');
    if (scripts.test) {
      lines.push('```bash');
      lines.push(`npm test          # ${commandDescription('test')}`);
      lines.push('```');
    }
    if (scripts['test:watch']) {
      lines.push('```bash');
      lines.push('npm run test:watch    # run tests in watch mode');
      lines.push('```');
    }
    if (scripts['test:coverage']) {
      lines.push('```bash');
      lines.push('npm run test:coverage    # run tests with coverage report');
      lines.push('```');
    }
    lines.push('');
  }

  // ── Linting & Formatting ──
  if (scripts.lint || scripts.format) {
    lines.push('### Linting & Code Quality');
    lines.push('');
    if (scripts.lint) {
      lines.push('```bash');
      lines.push(`npm run lint      # ${commandDescription('lint')}`);
      lines.push('```');
    }
    if (scripts['lint:fix']) {
      lines.push('```bash');
      lines.push('npm run lint:fix  # auto-fix linting issues');
      lines.push('```');
    }
    if (scripts.format) {
      lines.push('```bash');
      lines.push(`npm run format    # ${commandDescription('format')}`);
      lines.push('```');
    }
    lines.push('');
  }

  // ── Contributing ──
  if (data.fsCtx.contributing) {
    lines.push('### Contributing');
    lines.push('');
    // Extract the first meaningful section of CONTRIBUTING.md
    const contribLines = data.fsCtx.contributing.split('\n');
    const excerpt: string[] = [];
    let count = 0;
    for (const cl of contribLines) {
      excerpt.push(cl);
      count++;
      if (count >= 50) break;
    }
    lines.push(excerpt.join('\n').trim());
    lines.push('');
  }

  // ── Troubleshooting ──
  lines.push('### Troubleshooting');
  lines.push('');
  lines.push('| Issue | Likely Cause | Solution |');
  lines.push('|-------|-------------|----------|');
  lines.push('| Build fails with type errors | Missing or incompatible dependencies | Run `npm install` to ensure all deps are installed; check Node version matches `engines` requirement |');
  lines.push('| `Cannot find module` errors | Incorrect import paths or tsconfig paths | Verify `tsconfig.json` path mappings; re-run `npm run ingest` to refresh the graph |');
  if (data.fsCtx.envExample.length > 0) {
    lines.push('| Application crashes on startup | Missing environment variables | Copy `.env.example` to `.env` and fill in required values |');
  }
  lines.push('| KuzuDB lock errors | Another process holds the database lock | Ensure no other `codebase-oracle` instance is running; delete `.kuzu-lock` if stale |');
  lines.push('| Ollama connection refused | Ollama is not running or wrong URL | Start Ollama with `ollama serve`; verify `OLLAMA_URL` in config |');
  lines.push('');

  lines.push('---');
  lines.push('');
  return lines;
}

/** Generate a human-readable description for common npm script names. */
function commandDescription(name: string): string {
  const descriptions: Record<string, string> = {
    build: 'Compile TypeScript to JavaScript',
    start: 'Start the production server',
    dev: 'Start in development mode with hot reload',
    test: 'Run the test suite',
    'test:watch': 'Run tests in watch mode',
    'test:coverage': 'Run tests with code coverage',
    lint: 'Run the linter to check code quality',
    'lint:fix': 'Auto-fix linting issues',
    format: 'Format code with Prettier',
    ingest: 'Ingest a codebase into the knowledge graph',
    query: 'Query the knowledge graph',
    impact: 'Run impact analysis on a requirement',
    watch: 'Watch for file changes and re-ingest',
    setup: 'Install all dependencies (root + frontend)',
    frontend: 'Start the frontend dev server',
  };
  return descriptions[name] ?? `Run the ${name} script`;
}

// ── API section helpers ──────────────────────────────────────────────

/**
 * Group API endpoints by their parent module (using EXPOSES edges).
 * Returns a map of module → endpoints.
 */
function groupEndpointsByModule(data: PreparedData): Map<BaseNode, BaseNode[]> {
  const groups = new Map<BaseNode, BaseNode[]>();
  const exposesEdges = data.edgesByKind.get('EXPOSES') ?? [];

  // Build endpoint → module map
  const endpointModule = new Map<string, BaseNode>();
  for (const edge of exposesEdges) {
    const mod = resolveNode(edge.fromId, data);
    const ep = resolveNode(edge.toId, data);
    if (mod && ep && ep.kind === 'APIEndpoint') {
      endpointModule.set(ep.id, mod);
      if (!groups.has(mod)) groups.set(mod, []);
      groups.get(mod)!.push(ep);
    }
  }

  // Any endpoints not matched to a module → group under "(unresolved)"
  const unmatched: BaseNode[] = [];
  for (const ep of data.endpoints) {
    if (!endpointModule.has(ep.id) && isRealEndpoint(ep)) {
      unmatched.push(ep);
    }
  }
  if (unmatched.length > 0) {
    const ungrouped: BaseNode = {
      id: 'module:ungrouped',
      kind: 'Module',
      name: '(unresolved routes)',
      qualifiedName: '(unresolved)',
      filePath: '—',
      startLine: 0, endLine: 0,
      fingerprint: '',
      description: 'Endpoints that could not be associated with a specific module',
      metadata: '{}',
    };
    groups.set(ungrouped, unmatched);
  }

  return groups;
}

/** Build the API Endpoints & Routes section (enriched). */
function buildApiSection(data: PreparedData, llmEndpointDescs?: Map<string, string>): string[] {
  const lines: string[] = [];
  lines.push('## API Endpoints & Routes');
  lines.push('');

  // Real routes only — exclude test-file artifacts
  const realEndpoints = data.endpoints.filter(isRealEndpoint);

  if (realEndpoints.length === 0) {
    lines.push('_No API endpoints were detected._');
    lines.push('');
    lines.push('> **Note:** API endpoint detection covers Express, Fastify, decorator-based ' +
      'frameworks, and Next.js API routes. If your framework uses a different convention, ' +
      'endpoints may not appear here. Re-ingest after ensuring your route definitions are ' +
      'in standard patterns.');
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines;
  }

  // Summary table
  lines.push('### Endpoint Summary');
  lines.push('');
  lines.push(`The codebase exposes **${realEndpoints.length} API endpoint${realEndpoints.length === 1 ? '' : 's'}** across the following modules:`);
  lines.push('');
  lines.push('| Method | Path | Module | Line |');
  lines.push('|--------|------|--------|------|');
  for (const ep of realEndpoints.sort((a, b) => {
    const ma = parseMeta(a), mb = parseMeta(b);
    return (ma.path || '').localeCompare(mb.path || '');
  })) {
    const meta = parseMeta(ep);
    lines.push(`| ${meta.method || 'GET'} | \`${meta.path || ep.name}\` | \`${ep.filePath}\` | ${ep.startLine} |`);
  }
  lines.push('');

  // Grouped detail
  lines.push('### Endpoint Details by Module');
  lines.push('');
  const grouped = groupEndpointsByModule(data);
  for (const [mod, endpoints] of grouped) {
    lines.push(`#### \`${mod.filePath}\``);
    lines.push('');
    if (mod.description && mod.description !== mod.name) {
      lines.push(`> ${mod.description}`);
      lines.push('');
    }
    lines.push('| Method | Path | Handler | Line | Description |');
    lines.push('|--------|------|---------|------|-------------|');
    for (const ep of endpoints) {
      const meta = parseMeta(ep);
      // Try to find the handler function (the function that contains this endpoint)
      const handler = (data.incomingEdges.get(ep.id) ?? [])
        .filter(e => e.kind === 'CONTAINS' || e.kind === 'EXPOSES')
        .map(e => resolveNode(e.fromId, data))
        .find(n => n && (n.kind === 'Function' || n.kind === 'Method'));
      const handlerLink = handler ? nodeLink(handler, data) : '—';
      const desc = llmEndpointDescs?.get(ep.id) || (ep.description && ep.description !== `API endpoint: ${meta.method} ${meta.path}` ? ep.description : '—');
      lines.push(`| \`${meta.method || 'GET'}\` | \`${meta.path || ep.name}\` | ${handlerLink} | ${ep.startLine} | ${desc} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  return lines;
}

// ── LLM enrichment ───────────────────────────────────────────────────

/**
 * Generate an executive summary using the LLM provider.
 * Falls back gracefully if the provider is unavailable or errors.
 */
async function generateExecutiveSummary(
  data: PreparedData,
  repoName: string,
  provider: LLMProvider,
): Promise<string | null> {
  try {
    const totalNodes = Object.values(data.stats).reduce((a, b) => a + b, 0);
    const readmeExcerpt = data.fsCtx.readme
      ? data.fsCtx.readme.split('\n').slice(0, 30).join('\n')
      : '';
    const pkgDesc = data.fsCtx.rootPackageJson?.description || '';
    const topDomains = Array.from(
      new Set((data.nodesByKind.get('Module') ?? []).map(m => categorizeBusinessDomain(m.filePath)))
    ).slice(0, 8);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a technical writer producing a concise executive summary for a codebase documentation handbook. Write 2-3 paragraphs in plain English. Do not use markdown headings. Focus on: what the system does, its architecture, and its key technology choices.',
      },
      {
        role: 'user',
        content: `Repository: ${repoName}\n\nPackage description: ${pkgDesc}\n\nREADME excerpt:\n${readmeExcerpt}\n\nGraph stats: ${totalNodes} nodes, ${data.allEdges.length} edges.\nNode kinds: ${Object.entries(data.stats).map(([k, v]) => `${k} (${v})`).join(', ')}.\nBusiness domains: ${topDomains.join(', ')}.\nPatterns detected: ${data.patterns.map(p => p.name).join(', ') || 'none'}.\nEndpoints: ${data.endpoints.length}.\nTest framework: ${data.fsCtx.testFramework || 'unknown'}.\n\nWrite an executive summary for this codebase.`,
      },
    ];
    const result = await provider.chat(messages);
    return result?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Generate workflow narratives per business domain using the LLM.
 */
async function generateDomainNarratives(
  data: PreparedData,
  provider: LLMProvider,
): Promise<Map<string, string>> {
  const narratives = new Map<string, string>();
  const modules = data.nodesByKind.get('Module') ?? [];
  const domains = new Map<string, BaseNode[]>();
  for (const mod of modules) {
    const domain = categorizeBusinessDomain(mod.filePath);
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain)!.push(mod);
  }

  // Only generate narratives for the top 5 domains to limit LLM calls
  const topDomains = Array.from(domains.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);

  for (const [domain, mods] of topDomains) {
    try {
      const modNames = mods.slice(0, 10).map(m => `${m.name} (${m.filePath})`).join(', ');
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a technical writer. Write a 2-3 sentence workflow narrative for a business domain in a codebase. Describe what this domain does and how it fits into the overall system. Do not use markdown headings.',
        },
        {
          role: 'user',
          content: `Domain: ${domain}\nModules in this domain: ${modNames}\n\nWrite a brief workflow narrative for this domain.`,
        },
      ];
      const result = await provider.chat(messages);
      if (result?.trim()) {
        narratives.set(domain, result.trim());
      }
    } catch {
      // skip failed domains
    }
  }
  return narratives;
}

/**
 * Generate descriptions for API endpoints that lack JSDoc.
 */
async function generateEndpointDescriptions(
  data: PreparedData,
  provider: LLMProvider,
): Promise<Map<string, string>> {
  const descs = new Map<string, string>();
  // Only enrich endpoints without meaningful descriptions
  const needsDesc = data.endpoints.filter(ep => {
    const meta = parseMeta(ep);
    return !ep.description || ep.description === `API endpoint: ${meta.method} ${meta.path}`;
  });

  // Batch: send up to 20 endpoints in one LLM call
  const batch = needsDesc.slice(0, 20);
  if (batch.length === 0) return descs;

  try {
    const endpointList = batch.map(ep => {
      const meta = parseMeta(ep);
      return `- ${meta.method || 'GET'} ${meta.path || ep.name} (in ${ep.filePath}:${ep.startLine})`;
    }).join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a technical writer. For each API endpoint, write a brief one-line description of what it likely does. Return a numbered list matching the order of the endpoints provided. Do not include the method/path in your description — just describe the purpose.',
      },
      {
        role: 'user',
        content: `Describe these API endpoints:\n${endpointList}`,
      },
    ];
    const result = await provider.chat(messages);
    if (result) {
      const lines = result.split('\n').filter(l => l.trim().match(/^\d+/));
      for (let i = 0; i < lines.length && i < batch.length; i++) {
        const desc = lines[i].replace(/^\d+\.\s*/, '').trim();
        if (desc) descs.set(batch[i].id, desc);
      }
    }
  } catch {
    // skip
  }
  return descs;
}

// ── Markdown generator ──────────────────────────────────────────────

async function generateMarkdown(
  data: PreparedData,
  repoName: string,
  categories: DocCategory[],
  opts: DocGenOptions,
): Promise<string> {
  const lines: string[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ── LLM enrichment (optional) ──
  let execSummary: string | null = null;
  let domainNarratives: Map<string, string> | undefined;
  let endpointDescs: Map<string, string> | undefined;

  if (opts.includeLlmSummary && opts.provider) {
    // Run enrichments in parallel
    const [summary, narratives, epDescs] = await Promise.all([
      generateExecutiveSummary(data, repoName, opts.provider),
      categories.includes('business') ? generateDomainNarratives(data, opts.provider) : Promise.resolve(undefined),
      categories.includes('api') ? generateEndpointDescriptions(data, opts.provider) : Promise.resolve(undefined),
    ]);
    execSummary = summary;
    domainNarratives = narratives;
    endpointDescs = epDescs;
  }

  // Title
  lines.push(`# ${repoName} — Codebase & System Documentation`);
  lines.push('');
  lines.push(`> Auto-generated by Codebase Oracle on ${now}`);
  lines.push(`> This exhaustive handbook is derived from the knowledge graph and live filesystem, serving as both a developer guide and business reference.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Executive summary (LLM-enriched)
  if (execSummary) {
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(execSummary);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Table of contents
  lines.push('## Table of Contents');
  lines.push('');
  let tocIdx = 1;
  const toc: string[] = [];
  if (execSummary) toc.push(`${tocIdx++}. [Executive Summary](#executive-summary)`);
  if (categories.includes('business')) toc.push(`${tocIdx++}. [Business & Functional Overview](#business--functional-overview)`);
  if (categories.includes('architecture')) toc.push(`${tocIdx++}. [Architecture & System Design](#architecture--system-design)`);
  if (categories.includes('api')) toc.push(`${tocIdx++}. [API Endpoints & Routes](#api-endpoints--routes)`);
  if (categories.includes('technical')) toc.push(`${tocIdx++}. [Technical Code Reference](#technical-code-reference)`);
  if (categories.includes('developer')) toc.push(`${tocIdx++}. [Developer Guide & Setup](#developer-guide--setup)`);
  lines.push(...toc);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 1. Business / Functional Overview
  if (categories.includes('business')) {
    lines.push(...buildBusinessSection(data, repoName, domainNarratives));
  }

  // 2. Architecture & System Design
  if (categories.includes('architecture')) {
    lines.push('## Architecture & System Design');
    lines.push('');
    lines.push('### Project Overview & Statistics');
    lines.push('');
    const totalNodes = Object.values(data.stats).reduce((a, b) => a + b, 0);
    lines.push(`The knowledge graph contains **${totalNodes} nodes** and **${data.allEdges.length} edges** across the following categories:`);
    lines.push('');
    lines.push('| Category | Count |');
    lines.push('|----------|-------|');
    for (const [kind, count] of Object.entries(data.stats).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${kind} | ${count} |`);
    }
    lines.push(`| **Total** | **${totalNodes}** |`);
    lines.push('');
    lines.push(`| **Edges** | **${data.allEdges.length}** |`);
    lines.push('');
    // Edge kind breakdown
    lines.push('| Edge Kind | Count |');
    lines.push('|-----------|-------|');
    for (const [kind, edges] of Array.from(data.edgesByKind.entries()).sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`| ${edgeLabel(kind)} | ${edges.length} |`);
    }
    lines.push('');

    // Layered architecture narrative
    lines.push('### Layered Architecture');
    lines.push('');
    lines.push(...buildLayeredNarrative(data));

    // Mermaid diagrams
    lines.push(...buildMermaidDiagram(data));
    lines.push(...buildInheritanceDiagram(data));

    // Call-graph hotspots
    lines.push('### Call-Graph Hotspots');
    lines.push('');
    lines.push('The following functions and methods are the most heavily called in the codebase. ' +
      'They represent critical coupling points — changes to these have the widest impact:');
    lines.push('');
    lines.push(...buildCallGraphHotspots(data));

    // Pattern details with module mapping
    lines.push('### Detected Architecture Patterns');
    lines.push('');
    if (data.patterns.length === 0) {
      lines.push('_No architectural patterns were detected._');
      lines.push('');
    } else {
      lines.push(...buildPatternModuleMapping(data));
    }

    // Deployment view
    lines.push('### Deployment View');
    lines.push('');
    lines.push(...buildDeploymentView(data));

    lines.push('---');
    lines.push('');
  }

  // 3. API Endpoints & Routes
  if (categories.includes('api')) {
    lines.push(...buildApiSection(data, endpointDescs));
  }

  // 4. Technical Code Reference
  if (categories.includes('technical')) {
    lines.push('## Technical Code Reference');
    lines.push('');
    lines.push('This section provides an exhaustive reference of all extracted code structures, ' +
      'including signatures, metadata, relationships, and inline source snippets.');
    lines.push('');

    // Entity reference sections using the enriched formatEntityCard
    function entitySection(
      title: string,
      kinds: string[],
      includeSnippets: boolean,
    ): string[] {
      const out: string[] = [];
      out.push(`### ${title}`);
      out.push('');
      const entities: BaseNode[] = [];
      for (const k of kinds) {
        const items = data.nodesByKind.get(k);
        if (items) entities.push(...items);
      }
      entities.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

      if (entities.length === 0) {
        out.push('_None detected._');
        out.push('');
        return out;
      }

      out.push(`_${entities.length} ${title.toLowerCase().replace(' reference', '')}${entities.length === 1 ? '' : 's'} detected._`);
      out.push('');

      // Summary table for quick scanning
      out.push('| Name | Kind | Location | Key Attributes |');
      out.push('|------|------|----------|----------------|');
      for (const ent of entities) {
        const meta = parseMeta(ent);
        const attrs: string[] = [];
        if (meta.isAsync) attrs.push('async');
        if (meta.isExported) attrs.push('exported');
        if (meta.isAbstract) attrs.push('abstract');
        if (meta.paramCount !== undefined) attrs.push(`${meta.paramCount}p`);
        if (meta.returnType) attrs.push(`→${meta.returnType.slice(0, 20)}`);
        if (meta.methodCount !== undefined) attrs.push(`${meta.methodCount}m`);
        if (meta.propertyCount !== undefined) attrs.push(`${meta.propertyCount}prop`);
        const loc = `\`${ent.filePath}:${ent.startLine}\``;
        out.push(`| ${nodeLink(ent, data)} | ${ent.kind} | ${loc} | ${attrs.join(' · ') || '—'} |`);
      }
      out.push('');

      // Detailed cards
      for (const ent of entities) {
        out.push(...formatEntityCard(ent, data, includeSnippets));
      }
      return out;
    }

    lines.push(...entitySection('Class Reference', ['Class'], true));
    lines.push(...entitySection('Interface Reference', ['Interface'], true));
    lines.push(...entitySection('Function & Method Reference', ['Function', 'Method'], true));
    lines.push(...entitySection('Type & Enum Reference', ['TypeAlias', 'Enum', 'Namespace', 'Variable'], false));

    // Module breakdown (enriched with contained entities)
    lines.push('### Module Breakdown');
    lines.push('');
    const modules = (data.nodesByKind.get('Module') ?? []).sort((a, b) => a.filePath.localeCompare(b.filePath));
    if (modules.length > 0) {
      for (const mod of modules) {
        const anchor = nodeAnchorId(mod);
        lines.push(`#### \`${mod.filePath}\` {#${anchor}`);
        lines.push('');
        lines.push(`- **Module Name:** ${mod.name}`);
        lines.push(`- **Lines:** ${mod.startLine}–${mod.endLine}`);
        const modMeta = parseMeta(mod);
        if (modMeta.lineCount) lines.push(`- **Line Count:** ${modMeta.lineCount}`);
        if (modMeta.language) lines.push(`- **Language:** ${modMeta.language}`);
        if (mod.description && mod.description !== mod.name) lines.push(`- **Description:** ${mod.description}`);

        // List contained entities
        const contained = (data.outgoingEdges.get(mod.id) ?? [])
          .filter(e => e.kind === 'CONTAINS')
          .map(e => resolveNode(e.toId, data))
          .filter(Boolean) as BaseNode[];
        if (contained.length > 0) {
          lines.push(`- **Contains:** ${contained.length} entit${contained.length === 1 ? 'y' : 'ies'}`);
          // Group by kind
          const byKind = new Map<string, BaseNode[]>();
          for (const ent of contained) {
            if (!byKind.has(ent.kind)) byKind.set(ent.kind, []);
            byKind.get(ent.kind)!.push(ent);
          }
          for (const [kind, ents] of byKind) {
            const links = ents.slice(0, 10).map(e => nodeLink(e, data)).join(', ');
            const more = ents.length > 10 ? `, _+${ents.length - 10}_` : '';
            lines.push(`  - ${kind}: ${links}${more}`);
          }
        }

        // List imports
        const imports = (data.outgoingEdges.get(mod.id) ?? [])
          .filter(e => e.kind === 'IMPORTS')
          .map(e => resolveNode(e.toId, data))
          .filter(Boolean) as BaseNode[];
        if (imports.length > 0) {
          lines.push(`- **Imports:** ${imports.slice(0, 10).map(m => `\`${m.filePath}\``).join(', ')}${imports.length > 10 ? `, _+${imports.length - 10}_` : ''}`);
        }

        lines.push('');
      }
    }
    lines.push('---');
    lines.push('');
  }

  // 5. Developer Guide & Setup
  if (categories.includes('developer')) {
    lines.push(...buildDeveloperGuideSection(data, repoName));
  }

  lines.push(`*Generated by Codebase Oracle — ${now}*`);
  return lines.join('\n');
}

// ── HTML generator ──────────────────────────────────────────────────

async function generateHtml(data: PreparedData, repoName: string, categories: DocCategory[], opts: DocGenOptions): Promise<string> {
  const md = await generateMarkdown(data, repoName, categories, opts);
  return markdownToHtml(md, repoName);
}

/**
 * Lightweight Markdown → HTML converter.
 */
function markdownToHtml(md: string, title: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inTable = false;
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';
  let inBlockquote = false;
  let para: string[] = [];

  function flushPara() {
    if (para.length > 0) {
      html.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  }
  function closeList() {
    if (inList) { html.push(`</${listType}>`); inList = false; }
  }
  function closeTable() {
    if (inTable) { html.push('</tbody></table>'); inTable = false; }
  }
  function closeBlockquote() {
    if (inBlockquote) { html.push('</blockquote>'); inBlockquote = false; }
  }

  function inline(text: string): string {
    return text
      .replace(/`([^`]+)`/g, (_, code) => `<code>${esc(code)}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block (```lang ... ```)
    if (line.trim().startsWith('```')) {
      flushPara(); closeList(); closeTable(); closeBlockquote();
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      const langClass = lang ? ` class="language-${esc(lang)}"` : '';
      html.push(`<pre><code${langClass}>${esc(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Raw HTML passthrough (details, summary, etc.)
    if (/^<(details|summary|\/details|\/summary)\b/i.test(line.trim())) {
      flushPara(); closeList(); closeTable(); closeBlockquote();
      html.push(line.trim());
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushPara(); closeList(); closeTable(); closeBlockquote();
      html.push('<hr/>');
      continue;
    }

    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      flushPara(); closeList(); closeTable(); closeBlockquote();
      const level = hMatch[1].length;
      let headingText = hMatch[2];
      // Extract explicit {#anchor} if present
      let anchorId = '';
      const anchorMatch = headingText.match(/\{#([^}]+)\}\s*$/);
      if (anchorMatch) {
        anchorId = anchorMatch[1];
        headingText = headingText.replace(/\{#([^}]+)\}\s*$/, '');
      } else {
        anchorId = headingText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      const text = inline(headingText);
      html.push(`<h${level} id="${esc(anchorId)}">${text}</h${level}>`);
      continue;
    }

    if (line.startsWith('>')) {
      flushPara(); closeList(); closeTable();
      if (!inBlockquote) { html.push('<blockquote>'); inBlockquote = true; }
      html.push(`<p>${inline(line.slice(1).trim())}</p>`);
      continue;
    } else {
      closeBlockquote();
    }

    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      flushPara(); closeList();
      const cells = line.trim().split('|').slice(1, -1);

      if (cells.every(c => /^[\s:-]*-+[\s:-]*$/.test(c))) {
        continue;
      }

      if (!inTable) {
        html.push('<table><thead><tr>');
        for (const c of cells) html.push(`<th>${inline(c.trim())}</th>`);
        html.push('</tr></thead><tbody>');
        inTable = true;
        continue;
      }

      html.push('<tr>');
      for (const c of cells) html.push(`<td>${inline(c.trim())}</td>`);
      html.push('</tr>');
      continue;
    } else {
      closeTable();
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara(); closeTable();
      if (!inList || listType !== 'ul') { closeList(); html.push('<ul>'); inList = true; listType = 'ul'; }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara(); closeTable();
      if (!inList || listType !== 'ol') { closeList(); html.push('<ol>'); inList = true; listType = 'ol'; }
      html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      continue;
    }

    closeList();

    if (line.trim() === '') {
      flushPara();
      continue;
    }

    para.push(line.trim());
  }

  flushPara(); closeList(); closeTable(); closeBlockquote();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)} — Codebase Documentation</title>
<style>
  :root {
    --bg: #ffffff; --text: #1a1a2e; --muted: #6b7280;
    --border: #e5e7eb; --code-bg: #f3f4f6; --link: #4f46e5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1117; --text: #e8eaf0; --muted: #9ba3b8;
      --border: #252a3a; --code-bg: #1c2030; --link: #818cf8;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    background: var(--bg); color: var(--text);
    line-height: 1.7; max-width: 900px; margin: 0 auto; padding: 40px 24px;
  }
  h1 { font-size: 2em; border-bottom: 2px solid var(--border); padding-bottom: 8px; }
  h2 { font-size: 1.5em; margin-top: 2.5em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  h3 { font-size: 1.2em; margin-top: 1.8em; }
  h4 { font-size: 1.05em; margin-top: 1.4em; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: 'IBM Plex Mono', 'Fira Code', monospace;
    background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
    font-size: 0.88em;
  }
  pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 0.92em; }
  th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
  th { background: var(--code-bg); font-weight: 600; }
  tr:nth-child(even) { background: var(--code-bg); }
  blockquote {
    border-left: 4px solid var(--link); margin: 16px 0; padding: 8px 16px;
    color: var(--muted); background: var(--code-bg); border-radius: 0 8px 8px 0;
  }
  blockquote p { margin: 4px 0; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  .loc { color: var(--muted); font-size: 0.85em; }
  details { margin: 12px 0; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; background: var(--code-bg); }
  details > summary { cursor: pointer; font-weight: 600; }
  details > summary::marker { color: var(--link); }
  details[open] > summary { margin-bottom: 12px; }
  @media print { body { max-width: none; } details > summary { cursor: default; } }
</style>
</head>
<body>
${html.join('\n')}
</body>
</html>`;
}

// ── Public API ──────────────────────────────────────────────────────

export async function generateDocs(
  store: GraphStore,
  repoRoot: string,
  opts: DocGenOptions,
): Promise<DocGenResult> {
  const data = await gatherData(store, repoRoot);
  const repoName = path.basename(repoRoot);

  // Default: all categories included
  const categories = opts.categories ?? ['business', 'architecture', 'api', 'technical', 'developer'];

  let content: string;
  let filename: string;

  if (opts.format === 'html') {
    content = await generateHtml(data, repoName, categories, opts);
    filename = `${repoName}-docs.html`;
  } else {
    content = await generateMarkdown(data, repoName, categories, opts);
    filename = `${repoName}-docs.md`;
  }

  return { content, format: opts.format, filename };
}
