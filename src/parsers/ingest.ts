/**
 * Ingestion Engine
 *
 * Walks the repository file tree, dispatches each file to the appropriate
 * parser, and writes the resulting nodes + edges into KuzuDB.
 *
 * Supports incremental re-ingestion: only re-parses files whose content
 * hash has changed since the last run.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glob } from 'glob';
import { GraphStore } from '../graph/store.js';
import { TypeScriptParser, ParseResult } from './typescript-parser.js';
import { BaseNode, Edge } from '../ontology/schema.js';
import { LLMProvider } from '../llm/provider.js';
import { enrichNodeDescriptions, validatePatterns } from '../llm/enrichment.js';
import { repoDataDir, storeDirPatternInside } from '../util/paths.js';

export interface IngestOptions {
  repoRoot: string;
  include?: string[];   // glob patterns (default: ts/js/json)
  exclude?: string[];   // glob patterns
  incremental?: boolean; // default true
  /** Optional pre-initialized store. If provided, IngestEngine will use it
   *  instead of creating (and closing) its own. This avoids KuzuDB lock
   *  conflicts and native crashes from close/reopen cycles. */
  store?: GraphStore;
  /** Optional LLM provider for enrichment. When provided, node descriptions
   *  and architecture patterns are enhanced by the LLM. */
  llmProvider?: LLMProvider;
  /** Whether to use LLM enrichment (requires llmProvider). Default: false */
  useLlmEnrichment?: boolean;
}

const DEFAULT_INCLUDE = [
  '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
  '**/package.json',
];
const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
  '**/.codebase-oracle/**', '**/coverage/**', '**/*.d.ts',
  '**/*.min.js', '**/*.map',
];

export class IngestEngine {
  private store: GraphStore;
  private ownsStore: boolean;
  private tsParser: TypeScriptParser;
  private hashCache: Map<string, string>; // filePath → last fingerprint
  private hashCachePath: string;

  constructor(private opts: IngestOptions) {
    // Use provided store, or create our own
    if (opts.store) {
      this.store = opts.store;
      this.ownsStore = false;
    } else {
      this.store = new GraphStore(opts.repoRoot);
      this.ownsStore = true;
    }
    this.hashCache = new Map();
    this.hashCachePath = path.join(repoDataDir(opts.repoRoot), 'hash-cache.json');

    const tsconfigPath = path.join(opts.repoRoot, 'tsconfig.json');
    this.tsParser = new TypeScriptParser(
      fs.existsSync(tsconfigPath) ? tsconfigPath : undefined
    );
    // Phase 4: Load tsconfig paths and package.json exports for import resolution
    this.tsParser.loadPathConfig(opts.repoRoot);
  }

  async run(): Promise<{ filesProcessed: number; nodesCreated: number; edgesCreated: number }> {
    // Only init if we own the store (external stores are already initialized)
    if (this.ownsStore) await this.store.init();
    this.loadHashCache();

    const include = this.opts.include ?? DEFAULT_INCLUDE;
    const exclude = [...(this.opts.exclude ?? DEFAULT_EXCLUDE)];
    // Never ingest the app store dir if it lives inside the repo
    const storePattern = storeDirPatternInside(this.opts.repoRoot);
    if (storePattern) exclude.push(storePattern);

    const files = await glob(include, {
      cwd: this.opts.repoRoot,
      ignore: exclude,
      absolute: true,
      nodir: true,
    });

    let filesProcessed = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    // Phase 1: parse all files, collect nodes & edges
    const allNodes: BaseNode[] = [];
    const allEdges: Edge[] = [];

    for (const absPath of files) {
      const relPath = path.relative(this.opts.repoRoot, absPath);
      const content = fs.readFileSync(absPath, 'utf-8');
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      // Skip if unchanged (incremental mode)
      if (this.opts.incremental !== false && this.hashCache.get(relPath) === hash) {
        continue;
      }

      try {
        let result: ParseResult;
        if (/\.(ts|tsx|js|jsx)$/.test(absPath)) {
          result = this.tsParser.parseFile(absPath, this.opts.repoRoot);
        } else if (absPath.endsWith('package.json')) {
          result = this.parsePackageJson(absPath, this.opts.repoRoot);
        } else {
          continue;
        }

        // Remove old data for this file
        await this.store.deleteNodesByFile(relPath);

        allNodes.push(...result.nodes);
        allEdges.push(...result.edges);

        this.hashCache.set(relPath, hash);
        filesProcessed++;
      } catch (err: any) {
        console.warn(`⚠ Failed to parse ${relPath}: ${err.message}`);
      }
    }

    try {
      // Phase 2: deduplicate nodes and write to graph
      const nodeMap = new Map<string, BaseNode>();
      for (const node of allNodes) {
        const existing = nodeMap.get(node.id);
        if (!existing || node.filePath !== '') {
          nodeMap.set(node.id, node);
        }
      }

      for (const node of nodeMap.values()) {
        await this.store.upsertNode(node);
        totalNodes++;
      }

      // Phase 3: write edges (only if both endpoints exist)
      for (const edge of allEdges) {
        const from = nodeMap.has(edge.fromId) || (await this.store.getNode(edge.fromId));
        const to = nodeMap.has(edge.toId) || (await this.store.getNode(edge.toId));
        if (from && to) {
          await this.store.addEdge(edge);
          totalEdges++;
        }
      }

      this.saveHashCache();

      // Phase 4 (optional): LLM enrichment
      if (this.opts.useLlmEnrichment && this.opts.llmProvider) {
        await this.runLlmEnrichment([...nodeMap.values()]);
      }
    } finally {
      // Only close the store if we created it — external stores are
      // managed by the caller.
      if (this.ownsStore) await this.store.close();
    }

    return { filesProcessed, nodesCreated: totalNodes, edgesCreated: totalEdges };
  }

  /**
   * LLM enrichment: generates meaningful descriptions for nodes and
   * validates architecture patterns by analyzing actual code.
   */
  private async runLlmEnrichment(nodes: BaseNode[]): Promise<void> {
    const provider = this.opts.llmProvider!;

    // 1. Enrich node descriptions
    console.log('🧠 LLM enrichment: generating node descriptions...');
    const descUpdates = await enrichNodeDescriptions(
      provider,
      nodes,
      this.opts.repoRoot,
      (done, total) => {
        if (done % 5 === 0 || done === total) {
          console.log(`   📝 Descriptions: ${done}/${total} files`);
        }
      },
    );

    // Apply description updates to the store
    let descCount = 0;
    for (const [nodeId, description] of descUpdates) {
      const node = await this.store.getNode(nodeId);
      if (node) {
        node.description = description;
        await this.store.upsertNode(node);
        descCount++;
      }
    }
    console.log(`   ✓ Enriched ${descCount} node descriptions`);

    // 2. Validate architecture patterns
    console.log('🧠 LLM enrichment: validating architecture patterns...');
    const patternResults = await validatePatterns(provider, nodes, this.opts.repoRoot);
    for (const [patternName, result] of patternResults) {
      if (result.confirmed) {
        console.log(`   ✓ Pattern confirmed: ${patternName} — ${result.reasoning}`);
      } else {
        console.log(`   ✗ Pattern rejected: ${patternName} — ${result.reasoning}`);
      }
    }
  }

  /** Parse package.json as a Package node with DEPENDS_ON edges */
  private parsePackageJson(absPath: string, repoRoot: string): ParseResult {
    const relPath = path.relative(repoRoot, absPath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const pkg = JSON.parse(content);
    const nodes: BaseNode[] = [];
    const edges: Edge[] = [];

    const pkgId = `package:${crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 16)}`;
    nodes.push({
      id: pkgId,
      kind: 'Package',
      name: pkg.name ?? path.basename(path.dirname(absPath)),
      qualifiedName: relPath,
      filePath: relPath,
      startLine: 1,
      endLine: content.split('\n').length,
      fingerprint: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
      description: pkg.description ?? `Package: ${pkg.name}`,
      metadata: JSON.stringify({
        version: pkg.version,
        scripts: pkg.scripts ?? {},
        main: pkg.main,
        type: pkg.type,
        dependencies: pkg.dependencies ? Object.entries(pkg.dependencies).map(([n, v]) => `${n}@${v}`) : [],
        devDependencies: pkg.devDependencies ? Object.entries(pkg.devDependencies).map(([n, v]) => `${n}@${v}`) : [],
      }),
    });

    // Phase 4: Add DEPENDS_ON edges for each dependency
    const depCategories = [
      { deps: pkg.dependencies ?? {}, isDev: false },
      { deps: pkg.devDependencies ?? {}, isDev: true },
      { deps: pkg.peerDependencies ?? {}, isDev: false },
    ];

    for (const { deps, isDev } of depCategories) {
      for (const [depName, depVersion] of Object.entries(deps)) {
        const depId = `package:${crypto.createHash('sha256').update(`node_modules/${depName}`).digest('hex').slice(0, 16)}`;
        edges.push({
          fromId: pkgId,
          toId: depId,
          kind: 'DEPENDS_ON',
          weight: isDev ? 0.5 : 1.0,
          metadata: JSON.stringify({
            name: depName,
            version: String(depVersion),
            dev: isDev,
          }),
        });
      }
    }

    return { nodes, edges };
  }

  // ── Hash cache persistence ─────────────────────────────────────

  private loadHashCache(): void {
    try {
      if (fs.existsSync(this.hashCachePath)) {
        const data = JSON.parse(fs.readFileSync(this.hashCachePath, 'utf-8'));
        this.hashCache = new Map(Object.entries(data));
      }
    } catch {}
  }

  private saveHashCache(): void {
    const dir = path.dirname(this.hashCachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.hashCachePath,
      JSON.stringify(Object.fromEntries(this.hashCache), null, 2),
    );
  }
}
