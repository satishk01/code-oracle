/**
 * Tool Registration
 *
 * Wraps existing codebase-oracle capabilities (graph query, node lookup,
 * search, impact analysis, file read) as agent tools registered in a
 * {@link ToolRegistry}. This is pure refactoring: the existing functions
 * stay unchanged, they just get a registry entry so the AgentEngine can
 * offer them to the LLM.
 *
 * No change to CLI/API/frontend behavior — the registry is only consumed
 * by the agent layer (Phase 2).
 */

import fs from 'fs';
import path from 'path';
import { ToolRegistry, defineTool } from './registry.js';
import { GraphStore } from '../../graph/store.js';
import { ImpactAnalyzer } from '../../analysis/impact.js';
import type { ChangedItem } from '../../analysis/impact.js';

/**
 * Context passed to tool factories so tools can access the active graph
 * store and repo root. Mirrors OpenWorker's `AgentContext` pattern.
 */
export interface ToolContext {
  store: GraphStore;
  repoRoot: string;
  /** Optional impact analyzer (created lazily from the store). */
  impactAnalyzer?: ImpactAnalyzer;
}

/**
 * Build a {@link ToolRegistry} populated with all codebase-analysis tools
 * for the given context. Each tool is a thin wrapper over an existing
 * GraphStore / ImpactAnalyzer method.
 */
export function buildToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry();
  const impact = ctx.impactAnalyzer ?? new ImpactAnalyzer(ctx.store);

  // ── search_nodes ──────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'search_nodes',
    description:
      'Search the codebase knowledge graph for nodes (classes, functions, modules, etc.) ' +
      'by name, qualified name, or description. Returns up to 50 matching entities with ' +
      'their kind, file path, and line numbers. Use this to find code related to a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search term — matched against node names, qualified names, and descriptions.',
        },
      },
      required: ['query'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { error: 'query is required' };
      const nodes = await ctx.store.search(query);
      return {
        count: nodes.length,
        nodes: nodes.map(n => ({
          id: n.id,
          kind: n.kind,
          name: n.name,
          qualifiedName: n.qualifiedName,
          filePath: n.filePath,
          startLine: n.startLine,
          endLine: n.endLine,
          description: n.description,
        })),
      };
    },
  }));

  // ── get_node ──────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'get_node',
    description:
      'Get a single graph node by its ID, including its 2-hop neighborhood ' +
      '(related nodes and edges). Use this to inspect a specific entity and its ' +
      'direct relationships in detail.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'The unique node ID (e.g. "function:src/auth/login.ts::validateToken").',
        },
      },
      required: ['nodeId'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const nodeId = String(args.nodeId ?? '').trim();
      if (!nodeId) return { error: 'nodeId is required' };
      const node = await ctx.store.getNode(nodeId);
      if (!node) return { error: `Node not found: ${nodeId}` };
      const neighborhood = await ctx.store.getNeighborhood(nodeId, 2);
      return {
        node: {
          id: node.id,
          kind: node.kind,
          name: node.name,
          qualifiedName: node.qualifiedName,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          description: node.description,
          metadata: node.metadata,
        },
        neighborhood: {
          nodes: neighborhood.nodes.map(n => ({
            id: n.id, kind: n.kind, name: n.name,
            qualifiedName: n.qualifiedName, filePath: n.filePath,
          })),
          edges: neighborhood.edges,
        },
      };
    },
  }));

  // ── get_nodes_by_kind ─────────────────────────────────────────────
  registry.register(defineTool({
    name: 'get_nodes_by_kind',
    description:
      'Get all graph nodes of a specific kind. Useful for listing all classes, ' +
      'functions, API endpoints, architecture patterns, modules, etc.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description:
            'Node kind. One of: Module, Class, Interface, Function, Method, Variable, ' +
            'TypeAlias, Enum, Namespace, Package, ArchPattern, APIEndpoint, Config.',
        },
      },
      required: ['kind'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const kind = String(args.kind ?? '').trim();
      if (!kind) return { error: 'kind is required' };
      const nodes = await ctx.store.getNodesByKind(kind);
      return {
        count: nodes.length,
        nodes: nodes.map(n => ({
          id: n.id, kind: n.kind, name: n.name,
          qualifiedName: n.qualifiedName, filePath: n.filePath,
          startLine: n.startLine, endLine: n.endLine,
          description: n.description,
        })),
      };
    },
  }));

  // ── get_nodes_by_file ─────────────────────────────────────────────
  registry.register(defineTool({
    name: 'get_nodes_by_file',
    description:
      'Get all graph nodes defined in a specific source file. Returns the classes, ' +
      'functions, interfaces, etc. that live in that file.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'The file path (relative to repo root or absolute).',
        },
      },
      required: ['filePath'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const filePath = String(args.filePath ?? '').trim();
      if (!filePath) return { error: 'filePath is required' };
      const nodes = await ctx.store.getNodesByFile(filePath);
      return {
        count: nodes.length,
        nodes: nodes.map(n => ({
          id: n.id, kind: n.kind, name: n.name,
          qualifiedName: n.qualifiedName, filePath: n.filePath,
          startLine: n.startLine, endLine: n.endLine,
          description: n.description,
        })),
      };
    },
  }));

  // ── get_dependents ────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'get_dependents',
    description:
      'Get all nodes that depend on a given node (i.e. who calls, imports, extends, ' +
      'implements, or uses this entity). Essential for understanding the blast radius ' +
      'of a change.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'The node ID to find dependents for.',
        },
      },
      required: ['nodeId'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const nodeId = String(args.nodeId ?? '').trim();
      if (!nodeId) return { error: 'nodeId is required' };
      const dependents = await ctx.store.getDependents(nodeId);
      return {
        count: dependents.length,
        dependents: dependents.map(d => ({
          node: {
            id: d.node.id, kind: d.node.kind, name: d.node.name,
            qualifiedName: d.node.qualifiedName, filePath: d.node.filePath,
          },
          edgeKind: d.edgeKind,
        })),
      };
    },
  }));

  // ── get_graph_stats ───────────────────────────────────────────────
  registry.register(defineTool({
    name: 'get_graph_stats',
    description:
      'Get aggregate statistics about the codebase knowledge graph: counts of each ' +
      'node kind (classes, functions, modules, etc.). Useful for overview questions.',
    parameters: {
      type: 'object',
      properties: {},
    },
    riskLevel: 'read',
    handler: async () => {
      const stats = await ctx.store.getStats();
      return { stats };
    },
  }));

  // ── run_cypher ────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'run_cypher',
    description:
      'Run an arbitrary Cypher query against the KuzuDB graph database. ' +
      'Use this for advanced graph queries that the specialized tools cannot express. ' +
      'The graph has a single node label `CodeNode` (with a `kind` property) and a ' +
      'single relationship type `CodeEdge` (with a `kind` property). ' +
      'Example: MATCH (n:CodeNode) WHERE n.kind = "Class" RETURN n.name LIMIT 10',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A Cypher query string.',
        },
        params: {
          type: 'object',
          description: 'Optional query parameters (key-value pairs).',
        },
      },
      required: ['query'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return { error: 'query is required' };
      const params = (args.params as Record<string, unknown>) ?? {};
      const rows = await ctx.store.runCypher(query, params);
      return { rowCount: rows.length, rows };
    },
  }));

  // ── analyze_impact ────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'analyze_impact',
    description:
      'Analyze the impact (blast radius) of changing a set of files. Returns direct ' +
      'and transitive impacts, affected API endpoints, affected architecture patterns, ' +
      'and an overall risk score (0-100). Use this when the user asks "what happens if ' +
      'I change X" or "what does X affect".',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Path to the changed file.' },
              type: {
                type: 'string',
                enum: ['modified', 'added', 'deleted'],
                description: 'Type of change.',
              },
            },
            required: ['filePath', 'type'],
          },
          description: 'List of changed files with their change type.',
        },
      },
      required: ['files'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const files = args.files as ChangedItem[] | undefined;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return { error: 'files array is required' };
      }
      const report = await impact.analyzeChanges(files);
      return report;
    },
  }));

  // ── read_file ─────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'read_file',
    description:
      'Read the contents of a source file from the repository. Use this when you need ' +
      'to see the actual code, not just the graph metadata. Returns the file content ' +
      'as a string (truncated to 20000 chars for very large files).',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file, relative to the repo root.',
        },
      },
      required: ['filePath'],
    },
    riskLevel: 'read',
    handler: async (args) => {
      const filePath = String(args.filePath ?? '').trim();
      if (!filePath) return { error: 'filePath is required' };
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.repoRoot, filePath);
      // Safety: don't allow reading outside the repo root
      const rel = path.relative(ctx.repoRoot, absPath);
      if (rel.startsWith('..')) return { error: 'Cannot read files outside the repo root' };
      if (!fs.existsSync(absPath)) return { error: `File not found: ${filePath}` };
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) return { error: `Path is a directory, not a file: ${filePath}` };
      const content = fs.readFileSync(absPath, 'utf-8');
      const truncated = content.length > 20000;
      return {
        filePath,
        size: content.length,
        truncated,
        content: truncated ? content.slice(0, 20000) + '\n... [truncated]' : content,
      };
    },
  }));

  // ── list_files ────────────────────────────────────────────────────
  registry.register(defineTool({
    name: 'list_files',
    description:
      'List files and subdirectories at a given path within the repository. ' +
      'Use this to explore the repo structure. Returns names, paths, and whether ' +
      'each entry is a directory.',
    parameters: {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: 'Directory path relative to repo root. Use "" or "." for the root.',
        },
      },
    },
    riskLevel: 'read',
    handler: async (args) => {
      const dirPath = String(args.dirPath ?? '.').trim() || '.';
      const absPath = path.resolve(ctx.repoRoot, dirPath);
      const rel = path.relative(ctx.repoRoot, absPath);
      if (rel.startsWith('..')) return { error: 'Cannot list outside the repo root' };
      if (!fs.existsSync(absPath)) return { error: `Path not found: ${dirPath}` };
      if (!fs.statSync(absPath).isDirectory()) return { error: `Not a directory: ${dirPath}` };
      const entries = fs.readdirSync(absPath, { withFileTypes: true });
      return {
        path: dirPath,
        entries: entries
          .filter(e => !e.name.startsWith('.') || e.name === '.codebase-oracle')
          .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDirectory: e.isDirectory() }))
          .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1)),
      };
    },
  }));

  // ── Phase 4: validate_patterns ────────────────────────────────────
  // Agent-assisted pattern validation: lets the agent check detected
  // architecture patterns against actual code by reading files and
  // querying the graph. More accurate than pure string matching.
  registry.register(defineTool({
    name: 'validate_patterns',
    description:
      'Get detected architecture patterns for this codebase with their matched signals. ' +
      'Use this to understand what patterns the codebase follows (MVC, Repository, ' +
      'Factory, etc.) and verify them by reading the relevant source files.',
    parameters: {
      type: 'object',
      properties: {
        moduleId: {
          type: 'string',
          description: 'Optional: only return patterns for a specific module (file path).',
        },
      },
    },
    riskLevel: 'read',
    handler: async (args) => {
      const moduleId = args.moduleId as string | undefined;
      const cypher = moduleId
        ? `MATCH (m:CodeNode)-[r:CodeEdge]->(p:CodeNode) WHERE m.kind='Module' AND r.kind='FOLLOWS_PATTERN' AND m.id='${moduleId}' RETURN p, r`
        : `MATCH (m:CodeNode)-[r:CodeEdge]->(p:CodeNode) WHERE r.kind='FOLLOWS_PATTERN' RETURN p, r, m`;
      const result = await ctx.store.runCypher(cypher);
      const patterns = result.map((row: any) => ({
        pattern: row.p?.name ?? row.p?.qualifiedName,
        moduleId: row.m?.id,
        filePath: row.m?.filePath,
        weight: row.r?.weight,
        matchedSignals: (() => { try { return JSON.parse(row.r?.metadata ?? '{}').matchedSignals; } catch { return []; } })(),
      }));
      return { count: patterns.length, patterns };
    },
  }));

  // ── Phase 4: get_endpoints ────────────────────────────────────────
  // Agent-assisted endpoint discovery: lets the agent find all API
  // endpoints, including parameterized routes and nested routers that
  // the regex-based detection might miss.
  registry.register(defineTool({
    name: 'get_endpoints',
    description:
      'Get all detected API endpoints in the codebase. Returns method, path, ' +
      'and the source file that defines each endpoint. Use this to understand ' +
      'the API surface of the codebase.',
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'],
          description: 'Optional: filter by HTTP method.',
        },
      },
    },
    riskLevel: 'read',
    handler: async (args) => {
      const method = args.method as string | undefined;
      const cypher = method
        ? `MATCH (m:CodeNode)-[r:CodeEdge]->(e:CodeNode) WHERE r.kind='EXPOSES' AND e.kind='APIEndpoint' AND e.metadata CONTAINS '"method":"${method}"' RETURN e, m ORDER BY e.name`
        : `MATCH (m:CodeNode)-[r:CodeEdge]->(e:CodeNode) WHERE r.kind='EXPOSES' AND e.kind='APIEndpoint' RETURN e, m ORDER BY e.name`;
      const result = await ctx.store.runCypher(cypher);
      const endpoints = result.map((row: any) => {
        let meta: any = {};
        try { meta = JSON.parse(row.e?.metadata ?? '{}'); } catch {}
        return {
          id: row.e?.id,
          name: row.e?.name,
          method: meta.method,
          path: meta.path,
          filePath: row.e?.filePath,
          moduleFile: row.m?.filePath,
        };
      });
      return { count: endpoints.length, endpoints };
    },
  }));

  // ── Phase 4: get_package_deps ─────────────────────────────────────
  // Lets the agent inspect package dependencies and their relationships.
  registry.register(defineTool({
    name: 'get_package_deps',
    description:
      'Get package dependencies for this codebase. Returns the package name, ' +
      'version, and whether it is a dev dependency. Use this to understand ' +
      'what libraries the codebase depends on.',
    parameters: {
      type: 'object',
      properties: {
        includeDev: {
          type: 'boolean',
          description: 'Whether to include devDependencies (default: false).',
        },
      },
    },
    riskLevel: 'read',
    handler: async (args) => {
      const includeDev = args.includeDev ?? false;
      const cypher = includeDev
        ? `MATCH (p:CodeNode)-[r:CodeEdge]->(d:CodeNode) WHERE r.kind='DEPENDS_ON' RETURN r, p ORDER BY r.weight DESC`
        : `MATCH (p:CodeNode)-[r:CodeEdge]->(d:CodeNode) WHERE r.kind='DEPENDS_ON' AND r.weight >= 1.0 RETURN r, p ORDER BY r.weight DESC`;
      const result = await ctx.store.runCypher(cypher);
      const deps = result.map((row: any) => {
        let meta: any = {};
        try { meta = JSON.parse(row.r?.metadata ?? '{}'); } catch {}
        return {
          name: meta.name,
          version: meta.version,
          dev: meta.dev,
          weight: row.r?.weight,
        };
      });
      return { count: deps.length, dependencies: deps };
    },
  }));

  return registry;
}
