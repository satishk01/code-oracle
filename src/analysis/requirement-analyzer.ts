/**
 * Requirement-Based Impact & Implementation Plan Analyzer
 *
 * Takes a natural language requirement or developer question (e.g.,
 * "If I need to add two more endpoints what is the impact and also can you analyze where we have performance bottlenecks",
 * "Add OAuth2 authentication for Google login", "Implement rate-limiting middleware")
 * and computes:
 *  1. Semantic concept & intent recognition (APIs, performance, auth, database, UI, etc.)
 *  2. Matched code entities & target files with ranking
 *  3. Blast radius & transitive dependencies/callers
 *  4. Call-graph performance bottleneck & hotspot analysis
 *  5. Concrete, step-by-step implementation plan (deterministic fallback)
 *  6. Architectural pattern & API endpoint exposure mapping
 */

import { GraphStore } from '../graph/store.js';
import { BaseNode, Edge } from '../ontology/schema.js';

export interface PlanStep {
  phase: string;
  action: 'create' | 'modify' | 'configure' | 'test' | 'optimize';
  title: string;
  targetFile?: string;
  description: string;
  details?: string[];
}

export interface BottleneckInsight {
  component: string;
  filePath: string;
  type: 'coupling_hub' | 'database_query' | 'deep_call_chain' | 'sync_io' | 'async_loop' | 'unindexed_search';
  severity: 'high' | 'medium' | 'low';
  metrics: string;
  riskExplanation: string;
  recommendation: string;
}

export interface RequirementImpactResult {
  requirement: string;
  detectedIntents: string[];
  matchedEntities: { node: BaseNode; score: number; matchReason: string }[];
  impactedEntities: { node: BaseNode; depth: number; reason: string; relationship: string }[];
  affectedEndpoints: BaseNode[];
  affectedPatterns: { name: string; description: string; nodes: string[] }[];
  performanceBottlenecks: BottleneckInsight[];
  implementationPlan: PlanStep[];
  riskScore: number;
  summary: string;
  llmEnrichment?: {
    explanation: string;
    implementationPlan?: PlanStep[];
    bottleneckAnalysis?: string;
    severityAssessments: { name: string; severity: 'critical' | 'moderate' | 'low'; reasoning: string }[];
    testSuggestions: string[];
  };
}

// ── Domain & Intent Concept Mappings ──────────────────────────────────

interface DomainRule {
  intent: string;
  keywords: string[];
  nodeKindFilter?: string[];
  pathPatterns: string[];
  namePatterns: string[];
  planPhaseGenerators?: (matched: BaseNode[], allEndpoints: BaseNode[]) => PlanStep[];
}

const DOMAIN_RULES: DomainRule[] = [
  {
    intent: 'API & Route Management',
    keywords: ['endpoint', 'endpoints', 'route', 'routes', 'api', 'rest', 'http', 'controller', 'router', 'handler', 'request', 'response', 'post', 'get', 'put', 'delete'],
    pathPatterns: ['server', 'api', 'route', 'controller', 'router', 'handler', 'endpoint'],
    namePatterns: ['app', 'server', 'router', 'route', 'endpoint', 'handler', 'express', 'fastify', 'controller', 'api'],
  },
  {
    intent: 'Performance & Bottleneck Optimization',
    keywords: ['performance', 'bottleneck', 'bottlenecks', 'slow', 'latency', 'throughput', 'optimize', 'optimization', 'speed', 'scale', 'scaling', 'load', 'concurrency', 'hotspot', 'hotspots', 'memory'],
    pathPatterns: ['store', 'db', 'engine', 'parser', 'cache', 'graph', 'watcher'],
    namePatterns: ['store', 'db', 'query', 'search', 'engine', 'parser', 'fetch', 'read', 'exec', 'cache', 'loop'],
  },
  {
    intent: 'Authentication & Security',
    keywords: ['auth', 'authenticate', 'authentication', 'authorization', 'login', 'oauth', 'jwt', 'token', 'session', 'permission', 'permissions', 'security', 'role', 'roles', 'password', 'user', 'users'],
    pathPatterns: ['auth', 'security', 'permission', 'login', 'jwt', 'user', 'session'],
    namePatterns: ['auth', 'token', 'permission', 'validate', 'login', 'guard', 'policy', 'user', 'jwt'],
  },
  {
    intent: 'Data Layer & Persistence',
    keywords: ['database', 'db', 'store', 'storage', 'query', 'queries', 'sql', 'cypher', 'kuzu', 'schema', 'model', 'models', 'persist', 'persistence', 'cache', 'entity', 'entities', 'table'],
    pathPatterns: ['graph', 'db', 'store', 'schema', 'model', 'entity', 'migration', 'kuzu'],
    namePatterns: ['store', 'db', 'schema', 'entity', 'table', 'model', 'repository', 'dao', 'kuzu', 'query'],
  },
  {
    intent: 'AI & LLM Integration',
    keywords: ['llm', 'ai', 'prompt', 'model', 'stream', 'ollama', 'bedrock', 'omniroute', 'tools', 'agent', 'assistant', 'chat', 'inference', 'embedding'],
    pathPatterns: ['llm', 'agent', 'ollama', 'bedrock', 'omniroute', 'prompt', 'enrichment'],
    namePatterns: ['provider', 'agent', 'engine', 'prompt', 'enrich', 'chat', 'ollama', 'bedrock', 'omniroute', 'tool'],
  },
  {
    intent: 'User Interface & Frontend',
    keywords: ['ui', 'frontend', 'component', 'components', 'react', 'view', 'css', 'dashboard', 'page', 'tab', 'modal', 'form', 'button', 'display', 'client'],
    pathPatterns: ['frontend', 'ui', 'component', 'view', 'page', 'tab', 'hook'],
    namePatterns: ['tab', 'view', 'panel', 'component', 'app', 'button', 'form', 'modal', 'card'],
  },
  {
    intent: 'Testing & Quality Assurance',
    keywords: ['test', 'tests', 'testing', 'spec', 'coverage', 'vitest', 'jest', 'mock', 'unit', 'e2e', 'integration'],
    pathPatterns: ['test', 'spec', 'mock', '__tests__'],
    namePatterns: ['test', 'spec', 'mock', 'suite', 'assert'],
  },
  {
    intent: 'Documentation & Reporting',
    keywords: ['doc', 'docs', 'documentation', 'generator', 'handbook', 'markdown', 'html', 'export', 'report', 'summary'],
    pathPatterns: ['docs', 'generator', 'report', 'fs-context'],
    namePatterns: ['generator', 'doc', 'markdown', 'html', 'export', 'summary'],
  },
  {
    intent: 'Impact & Codebase Analysis',
    keywords: ['impact', 'blast', 'radius', 'analysis', 'analyzer', 'dependency', 'dependencies', 'watcher', 'ast', 'parser', 'ingest'],
    pathPatterns: ['analysis', 'impact', 'parser', 'ingest', 'watcher'],
    namePatterns: ['impact', 'analyzer', 'parser', 'ingest', 'watcher', 'ast'],
  },
];

// ── Stop words for token filtering ────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were',
  'and', 'or', 'as', 'if', 'when', 'how', 'what', 'which', 'who', 'where', 'why',
  'can', 'could', 'should', 'would', 'must', 'will', 'need', 'needs', 'want', 'wants',
  'please', 'pelae', 'also', 'some', 'any', 'all', 'more', 'less', 'two', 'three', 'one',
  'we', 'i', 'you', 'they', 'our', 'my', 'your', 'their', 'it', 'its', 'have', 'has', 'do', 'does',
]);

export class RequirementAnalyzer {
  constructor(private store: GraphStore) {}

  async analyze(requirement: string): Promise<RequirementImpactResult> {
    const rawReq = requirement.trim();
    const cleanTokens = this.tokenize(rawReq);

    const [allNodes, allEdges, allEndpoints, allPatterns] = await Promise.all([
      this.store.getAllNodes(),
      this.store.getAllEdges(),
      this.store.getNodesByKind('APIEndpoint'),
      this.store.getNodesByKind('ArchPattern'),
    ]);

    // 1. Detect Intents
    const detectedIntents = this.detectIntents(cleanTokens, rawReq);

    // 2. Score & match entities
    const matchedEntities = this.scoreNodes(allNodes, cleanTokens, rawReq, detectedIntents);

    // 3. Compute blast radius / dependencies
    const { impactedEntities, affectedEndpoints } = this.computeBlastRadius(
      matchedEntities.map(m => m.node),
      allNodes,
      allEdges,
      allEndpoints
    );

    // 4. Detect affected architectural patterns
    const affectedPatterns = this.detectAffectedPatterns(
      [...matchedEntities.map(m => m.node), ...impactedEntities.map(i => i.node)],
      allPatterns,
      allEdges
    );

    // 5. Detect performance bottlenecks & hotspots
    const performanceBottlenecks = this.analyzeBottlenecks(
      allNodes,
      allEdges,
      matchedEntities.map(m => m.node),
      detectedIntents
    );

    // 6. Generate Deterministic Step-by-Step Implementation Plan
    const implementationPlan = this.generatePlan(
      rawReq,
      detectedIntents,
      matchedEntities.map(m => m.node),
      affectedEndpoints,
      performanceBottlenecks,
      allNodes
    );

    // 7. Calculate Risk Score
    const riskScore = this.calculateRiskScore(
      matchedEntities,
      impactedEntities,
      affectedEndpoints,
      performanceBottlenecks,
      detectedIntents
    );

    // 8. Generate comprehensive summary
    const summary = this.buildSummary(
      rawReq,
      detectedIntents,
      matchedEntities,
      impactedEntities,
      affectedEndpoints,
      performanceBottlenecks,
      implementationPlan,
      riskScore
    );

    return {
      requirement: rawReq,
      detectedIntents,
      matchedEntities,
      impactedEntities,
      affectedEndpoints,
      affectedPatterns,
      performanceBottlenecks,
      implementationPlan,
      riskScore,
      summary,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  }

  private detectIntents(tokens: string[], rawText: string): string[] {
    const lower = rawText.toLowerCase();
    const matched = new Set<string>();

    for (const rule of DOMAIN_RULES) {
      for (const kw of rule.keywords) {
        if (tokens.includes(kw) || lower.includes(kw)) {
          matched.add(rule.intent);
          break;
        }
      }
    }

    if (matched.size === 0) {
      matched.add('General Feature Implementation');
    }

    return Array.from(matched);
  }

  private scoreNodes(
    allNodes: BaseNode[],
    tokens: string[],
    rawText: string,
    intents: string[]
  ): { node: BaseNode; score: number; matchReason: string }[] {
    const scored: { node: BaseNode; score: number; matchReason: string }[] = [];
    const lowerReq = rawText.toLowerCase();

    for (const node of allNodes) {
      let score = 0;
      const reasons: string[] = [];

      const nameLower = node.name.toLowerCase();
      const qnLower = node.qualifiedName.toLowerCase();
      const fileLower = (node.filePath || '').toLowerCase();
      const descLower = (node.description || '').toLowerCase();

      // Check intent-specific rules
      for (const intentName of intents) {
        const rule = DOMAIN_RULES.find(r => r.intent === intentName);
        if (!rule) continue;

        // Path matches
        for (const pp of rule.pathPatterns) {
          if (fileLower.includes(pp)) {
            score += 4;
            reasons.push(`File matches intent "${intentName}"`);
            break;
          }
        }

        // Name matches
        for (const np of rule.namePatterns) {
          if (nameLower.includes(np)) {
            score += 5;
            reasons.push(`Component matches intent "${intentName}"`);
            break;
          }
        }

        // Endpoint kind bonus if API intent
        if (intentName === 'API & Route Management' && (node.kind === 'APIEndpoint' || fileLower.includes('server') || fileLower.includes('router') || fileLower.includes('api'))) {
          score += 6;
          reasons.push(`Key API routing component`);
        }

        // Store / DB bonus if Data / Performance intent
        if ((intentName === 'Data Layer & Persistence' || intentName === 'Performance & Bottleneck Optimization') &&
            (node.kind === 'Class' && (nameLower.includes('store') || nameLower.includes('db') || nameLower.includes('cache')))) {
          score += 6;
          reasons.push(`Critical data/storage structure`);
        }
      }

      // Keyword token matches
      for (const token of tokens) {
        if (nameLower === token) {
          score += 10;
          reasons.push(`Exact name match: "${token}"`);
        } else if (nameLower.includes(token)) {
          score += 5;
          reasons.push(`Name contains: "${token}"`);
        } else if (qnLower.includes(token)) {
          score += 3;
          reasons.push(`Qualified name contains: "${token}"`);
        } else if (fileLower.includes(token)) {
          score += 3;
          reasons.push(`Path contains: "${token}"`);
        } else if (descLower.includes(token)) {
          score += 2;
          reasons.push(`Description mentions: "${token}"`);
        }
      }

      // Special check for "endpoint" query
      if (lowerReq.includes('endpoint') || lowerReq.includes('route') || lowerReq.includes('api')) {
        if (fileLower.includes('server.ts') || fileLower.includes('app.ts') || fileLower.includes('routes') || fileLower.includes('api/')) {
          score += 8;
          reasons.push(`Main HTTP/API server registration file`);
        }
      }

      if (score > 0) {
        const uniqueReasons = Array.from(new Set(reasons)).slice(0, 3).join('; ');
        scored.push({ node, score, matchReason: uniqueReasons || 'Keyword similarity' });
      }
    }

    // Sort by score descending and return top matches
    scored.sort((a, b) => b.score - a.score);

    // If no matches found via tokens, fallback to entry points and core servers
    if (scored.length === 0) {
      for (const node of allNodes) {
        const fileLower = (node.filePath || '').toLowerCase();
        if (fileLower.includes('server.ts') || fileLower.includes('app.ts') || fileLower.includes('index.ts') || fileLower.includes('cli.ts') || node.kind === 'APIEndpoint') {
          scored.push({ node, score: 5, matchReason: 'Core entry point / server' });
        }
      }
    }

    return scored.slice(0, 25);
  }

  private computeBlastRadius(
    seedNodes: BaseNode[],
    allNodes: BaseNode[],
    allEdges: Edge[],
    allEndpoints: BaseNode[]
  ): { impactedEntities: { node: BaseNode; depth: number; reason: string; relationship: string }[]; affectedEndpoints: BaseNode[] } {
    const nodeMap = new Map<string, BaseNode>(allNodes.map(n => [n.id, n]));
    const seedIds = new Set<string>(seedNodes.map(n => n.id));
    const visited = new Set<string>(seedIds);
    const impacts: { node: BaseNode; depth: number; reason: string; relationship: string }[] = [];
    const affectedEndpointsList: BaseNode[] = [];
    const endpointIds = new Set<string>(allEndpoints.map(e => e.id));

    // Gather 1-hop and 2-hop dependents/dependencies
    for (const seed of seedNodes) {
      const inEdges = allEdges.filter(e => e.toId === seed.id && ['CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'EXPOSES'].includes(e.kind));
      const outEdges = allEdges.filter(e => e.fromId === seed.id && ['CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'EXPOSES'].includes(e.kind));

      // Upstream callers/importers
      for (const e of inEdges) {
        const dep = nodeMap.get(e.fromId);
        if (dep && !visited.has(dep.id)) {
          visited.add(dep.id);
          const rel = e.kind === 'CALLS' ? 'calls' : e.kind === 'IMPORTS' ? 'imports' : e.kind === 'EXPOSES' ? 'exposes' : 'depends on';
          impacts.push({
            node: dep,
            depth: 1,
            relationship: e.kind,
            reason: `Upstream: ${dep.name} ${rel} ${seed.name}`,
          });
          if (dep.kind === 'APIEndpoint' || endpointIds.has(dep.id)) {
            affectedEndpointsList.push(dep);
          }
        }
      }

      // Downstream dependencies
      for (const e of outEdges) {
        const dep = nodeMap.get(e.toId);
        if (dep && !visited.has(dep.id)) {
          visited.add(dep.id);
          const rel = e.kind === 'CALLS' ? 'invoked by' : e.kind === 'IMPORTS' ? 'imported by' : e.kind === 'EXPOSES' ? 'exposed by' : 'required by';
          impacts.push({
            node: dep,
            depth: 1,
            relationship: e.kind,
            reason: `Downstream: ${dep.name} is ${rel} ${seed.name}`,
          });
          if (dep.kind === 'APIEndpoint' || endpointIds.has(dep.id)) {
            affectedEndpointsList.push(dep);
          }
        }
      }
    }

    // Include seed nodes that are endpoints
    for (const seed of seedNodes) {
      if (seed.kind === 'APIEndpoint' && !affectedEndpointsList.some(e => e.id === seed.id)) {
        affectedEndpointsList.push(seed);
      }
    }

    return {
      impactedEntities: impacts.slice(0, 35),
      affectedEndpoints: affectedEndpointsList.slice(0, 20),
    };
  }

  private detectAffectedPatterns(
    nodes: BaseNode[],
    allPatterns: BaseNode[],
    allEdges: Edge[]
  ): { name: string; description: string; nodes: string[] }[] {
    const nodeIds = new Set(nodes.map(n => n.id));
    const followsEdges = allEdges.filter(e => e.kind === 'FOLLOWS_PATTERN' && nodeIds.has(e.fromId));
    const results: { name: string; description: string; nodes: string[] }[] = [];

    const patternMap = new Map<string, BaseNode>(allPatterns.map(p => [p.id, p]));
    const patternNodes = new Map<string, Set<string>>();

    for (const e of followsEdges) {
      if (!patternNodes.has(e.toId)) patternNodes.set(e.toId, new Set());
      const n = nodes.find(item => item.id === e.fromId);
      if (n) patternNodes.get(e.toId)!.add(n.name);
    }

    for (const [patId, nodeNames] of patternNodes) {
      const pat = patternMap.get(patId);
      if (pat) {
        results.push({
          name: pat.name,
          description: pat.description || `Pattern ${pat.name}`,
          nodes: Array.from(nodeNames),
        });
      }
    }

    return results;
  }

  private analyzeBottlenecks(
    allNodes: BaseNode[],
    allEdges: Edge[],
    matchedNodes: BaseNode[],
    intents: string[]
  ): BottleneckInsight[] {
    const insights: BottleneckInsight[] = [];
    const nodeMap = new Map<string, BaseNode>(allNodes.map(n => [n.id, n]));

    // 1. High In-Degree Coupling Hubs (Most called functions/classes)
    const inDegreeMap = new Map<string, number>();
    for (const e of allEdges.filter(e => e.kind === 'CALLS' || e.kind === 'IMPORTS')) {
      inDegreeMap.set(e.toId, (inDegreeMap.get(e.toId) ?? 0) + 1);
    }

    const sortedHubs = Array.from(inDegreeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [id, count] of sortedHubs) {
      const node = nodeMap.get(id);
      if (node && count >= 3) {
        insights.push({
          component: node.name,
          filePath: node.filePath,
          type: 'coupling_hub',
          severity: count >= 8 ? 'high' : 'medium',
          metrics: `${count} incoming callers/importers`,
          riskExplanation: `Highly coupled central component. Changes or latency in ${node.name} cascade to ${count} dependent modules.`,
          recommendation: `Ensure non-blocking async execution, cache repeated lookups, and keep this interface backward compatible.`,
        });
      }
    }

    // 2. Database & Graph Query touchpoints
    const dbNodes = allNodes.filter(n => {
      const fn = (n.name + ' ' + n.qualifiedName).toLowerCase();
      return (
        (n.kind === 'Class' || n.kind === 'Function' || n.kind === 'Method') &&
        (fn.includes('query') || fn.includes('exec') || fn.includes('cypher') || fn.includes('store') || fn.includes('find') || fn.includes('getnode'))
      );
    });

    for (const dbNode of dbNodes.slice(0, 3)) {
      insights.push({
        component: dbNode.name,
        filePath: dbNode.filePath,
        type: 'database_query',
        severity: 'medium',
        metrics: 'Direct disk/graph I/O boundary',
        riskExplanation: `${dbNode.name} accesses underlying graph/disk storage. Unbatched queries in tight loops cause noticeable latency.`,
        recommendation: `Batch read/write transactions, avoid single-item lookups inside iterations, and reuse active connections.`,
      });
    }

    // 3. File System / Sync I/O boundaries
    const ioNodes = allNodes.filter(n => {
      const desc = (n.description || '').toLowerCase();
      const name = n.name.toLowerCase();
      return (
        (name.includes('read') || name.includes('write') || name.includes('ingest') || name.includes('load')) &&
        (desc.includes('file') || desc.includes('disk') || desc.includes('sync'))
      );
    });

    for (const ioNode of ioNodes.slice(0, 2)) {
      insights.push({
        component: ioNode.name,
        filePath: ioNode.filePath,
        type: 'sync_io',
        severity: 'medium',
        metrics: 'File I/O operations',
        riskExplanation: `${ioNode.name} performs filesystem operations. Large repositories may cause event-loop lag.`,
        recommendation: `Use stream readers or asynchronous fs promises for large payloads.`,
      });
    }

    return insights;
  }

  private generatePlan(
    requirement: string,
    intents: string[],
    matchedNodes: BaseNode[],
    affectedEndpoints: BaseNode[],
    bottlenecks: BottleneckInsight[],
    allNodes: BaseNode[]
  ): PlanStep[] {
    const steps: PlanStep[] = [];
    const lower = requirement.toLowerCase();

    // Find main router/server file
    const serverFile = allNodes.find(n => (n.filePath || '').toLowerCase().includes('server.ts') && n.kind === 'Module') ||
                       allNodes.find(n => (n.filePath || '').toLowerCase().includes('app.ts') && n.kind === 'Module') ||
                       matchedNodes.find(n => n.kind === 'Module');

    const serverFilePath = serverFile?.filePath || 'src/api/server.ts';

    // Phase 1: Architecture & Data Model Setup
    steps.push({
      phase: '1. Architecture & Design',
      action: 'configure',
      title: 'Define Request/Response Schemas & Contracts',
      targetFile: 'src/api/validation.ts (or schema definitions)',
      description: 'Define robust input validation schemas (Zod/JSON Schema) and TypeScript interfaces for the new feature or endpoints.',
      details: [
        'Define request body and query parameter validation schemas.',
        'Create typed response models to enforce consistent API contracts.',
        'Add validation middleware in router registration.',
      ],
    });

    // Phase 2: Core Logic & Service Layer
    if (intents.includes('API & Route Management') || lower.includes('endpoint') || lower.includes('route')) {
      steps.push({
        phase: '2. Service & Handler Implementation',
        action: 'create',
        title: 'Implement Business Logic & Service Methods',
        targetFile: matchedNodes[0]?.filePath || 'src/services/',
        description: 'Implement domain logic isolated from the transport layer, ensuring separation of concerns.',
        details: [
          'Encapsulate business operations in dedicated handler/service functions.',
          'Inject dependencies (GraphStore, LLMProvider, etc.) to keep methods unit-testable.',
          'Implement explicit error handling and status code mappings.',
        ],
      });

      // Phase 3: Route Registration
      steps.push({
        phase: '3. Route & Middleware Wiring',
        action: 'modify',
        title: 'Mount New Endpoints & Middleware',
        targetFile: serverFilePath,
        description: `Register the new route paths (e.g. POST/GET) on the Express/Fastify router in \`${serverFilePath}\`.`,
        details: [
          `Add route declarations to \`${serverFilePath}\` with input validation middleware.`,
          'Mount any required authorization, rate-limiting, or logging middleware.',
          'Document the endpoints in the Swagger/OpenAPI or API reference generator.',
        ],
      });
    } else {
      steps.push({
        phase: '2. Core Logic Implementation',
        action: 'modify',
        title: 'Implement Core Feature Functionality',
        targetFile: matchedNodes[0]?.filePath || 'src/',
        description: `Implement the requested requirement in the primary domain component (\`${matchedNodes[0]?.name || 'core service'}\`).`,
        details: [
          'Modify core interfaces and classes to support the new capability.',
          'Ensure backward compatibility with existing callers.',
        ],
      });
    }

    // Phase 4: Performance & Bottleneck Mitigation
    if (bottlenecks.length > 0 || intents.includes('Performance & Bottleneck Optimization') || lower.includes('bottleneck')) {
      const topBottleneck = bottlenecks[0];
      steps.push({
        phase: '4. Performance & Concurrency Tuning',
        action: 'optimize',
        title: 'Mitigate High-Coupling & I/O Bottlenecks',
        targetFile: topBottleneck?.filePath || 'src/graph/store.ts',
        description: `Optimize data access and high-traffic coupling points identified during analysis.`,
        details: [
          topBottleneck ? `Optimize ${topBottleneck.component} (${topBottleneck.metrics}): ${topBottleneck.recommendation}` : 'Ensure non-blocking database queries.',
          'Add response caching or in-memory memoization for frequently queried data.',
          'Verify connection pool and lock management to avoid blocking concurrent requests.',
        ],
      });
    }

    // Phase 5: Testing & Verification
    steps.push({
      phase: '5. Testing & Verification',
      action: 'test',
      title: 'Automated Test Coverage & Validation',
      targetFile: 'src/**/__tests__/',
      description: 'Write unit and integration tests covering the happy path, boundary validation, and failure scenarios.',
      details: [
        'Add integration tests verifying endpoint status codes and error responses.',
        'Add unit tests for the core business logic with mocked dependencies.',
        'Run `npm test` and `npm run build` to verify zero type errors and clean compilation.',
      ],
    });

    return steps;
  }

  private calculateRiskScore(
    matched: { node: BaseNode; score: number }[],
    impacted: { node: BaseNode; depth: number }[],
    endpoints: BaseNode[],
    bottlenecks: BottleneckInsight[],
    intents: string[]
  ): number {
    let score = 15; // base

    score += Math.min(30, matched.length * 3);
    score += Math.min(25, impacted.length * 2);
    score += Math.min(20, endpoints.length * 4);

    if (bottlenecks.some(b => b.severity === 'high')) score += 15;
    else if (bottlenecks.length > 0) score += 8;

    if (intents.includes('Authentication & Security')) score += 15;
    if (intents.includes('Data Layer & Persistence')) score += 10;

    return Math.min(95, Math.max(10, score));
  }

  private buildSummary(
    req: string,
    intents: string[],
    matched: { node: BaseNode; score: number }[],
    impacted: { node: BaseNode; depth: number }[],
    endpoints: BaseNode[],
    bottlenecks: BottleneckInsight[],
    plan: PlanStep[],
    riskScore: number
  ): string {
    const intentList = intents.join(', ');
    return `### Requirement Impact Analysis Summary

**Requirement:** "${req}"
**Detected Intents:** ${intentList}
**Overall Risk Score:** ${riskScore}/100

- **Primary Target Components:** ${matched.length} components identified across ${new Set(matched.map(m => m.node.filePath)).size} files.
- **Transitive Blast Radius:** ${impacted.length} upstream/downstream dependencies affected.
- **Affected Endpoints:** ${endpoints.length} API routes involved.
- **Performance Hotspots Identified:** ${bottlenecks.length} critical coupling/IO points.
- **Actionable Plan:** Generated a ${plan.length}-phase implementation roadmap.`;
  }
}
