/**
 * REST API Server
 *
 * Serves the graph data, impact analysis, and Q&A endpoints
 * for the React frontend.
 *
 * Architecture: The server keeps a single GraphStore + RepoWatcher + OllamaQA
 * for the currently active repo. IngestEngine uses the server's existing
 * store (no close/reopen — that crashes KuzuDB's native library). A
 * RepoRegistry tracks all repos that have ever been indexed.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { GraphStore } from '../graph/store.js';
import { IngestEngine } from '../parsers/ingest.js';
import { ImpactAnalyzer, ChangedItem } from '../analysis/impact.js';
import { RequirementAnalyzer } from '../analysis/requirement-analyzer.js';
import { RepoWatcher } from '../analysis/watcher.js';
import { OllamaQA } from '../llm/ollama.js';
import { createToolCapableProvider, isToolCapable } from '../llm/provider.js';
import type { LLMProvider } from '../llm/provider.js';
import { generateDocs } from '../docs/generator.js';
import type { DocFormat, DocCategory } from '../docs/generator.js';
import { RepoRegistry } from '../repo-registry.js';
import { enrichImpactAnalysis, enrichRequirementImpact } from '../llm/enrichment.js';
import { AgentEngine, eventToSSE, EventType, JsonMemoryStore, AuditStore, PermissionEngine, modeDescription } from '../agent/index.js';
import type { PermissionMode } from '../agent/index.js';
import { logger } from '../util/logger.js';
import { repoDataDir } from '../util/paths.js';
import {
  askSchema,
  setRepoSchema,
  ingestSchema,
  impactSchema,
  requirementImpactSchema,
  removeRepoSchema,
  permissionResolveSchema,
  permissionModeSchema,
  addMemorySchema,
  clearMemorySchema,
  cypherSchema,
} from './validation.js';

// Catch uncaught errors so the server doesn't silently crash
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 UNHANDLED REJECTION:', err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Resolve repo root from env or CLI arg (mutable — can be changed via API)
let REPO_ROOT = config.repoRoot;
const PORT = config.port;
const SYSTEM_PROMPT = config.ollamaSystemPrompt;

/** LLM provider selected via LLM_PROVIDER env var (ollama | omniroute | bedrock). */
function buildLLMProvider(): LLMProvider {
  return createToolCapableProvider({
    provider: config.llmProvider,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    omnirouteUrl: config.omnirouteUrl,
    omnirouteModel: config.omnirouteModel,
    omnirouteApiKey: config.omnirouteApiKey,
    bedrockRegion: config.bedrockRegion,
    bedrockModel: config.bedrockModel,
    bedrockAuthMethod: config.bedrockAuthMethod,
    bedrockAccessKeyId: config.bedrockAccessKeyId,
    bedrockSecretAccessKey: config.bedrockSecretAccessKey,
    bedrockSessionToken: config.bedrockSessionToken,
    bedrockApiKey: config.bedrockApiKey,
    bedrockEndpoint: config.bedrockEndpoint,
  });
}

let store: GraphStore;
let qa: OllamaQA;
let watcher: RepoWatcher;
let latestImpactReport: any = null;
const registry = new RepoRegistry();

// Physically delete data directories queued by a previous run, then move
// any legacy per-repo .codebase-oracle directories into the store dir.
// Both must happen before the first GraphStore is created — touching
// files under a live KuzuDB database can abort the native library and
// kill the process. We also retry deletions on exit, when handles may
// already be released.
registry.drainPendingDeletes();
registry.migrateLegacyData();
process.on('exit', () => registry.drainPendingDeletes());

// ── Phase 3: Shared agent infrastructure ───────────────────────────
// Memory store, audit log, and permission engine are shared across all
// requests for the same repo. They are re-created when the active repo changes.

let memoryStore: JsonMemoryStore;
let auditStore: AuditStore;
let permissionEngine: PermissionEngine;
/** Map of active agent engines (for permission resolution from the UI). */
const activeEngines = new Map<string, AgentEngine>();

function initAgentInfra(repoRoot: string, permMode?: PermissionMode) {
  memoryStore = new JsonMemoryStore(repoRoot);
  auditStore = new AuditStore(repoRoot);
  const mode = permMode ?? (config.agentPermissionMode as PermissionMode) ?? 'interactive';
  permissionEngine = new PermissionEngine(mode);
  logger.info('Agent infrastructure initialized', { repoRoot, permMode: permissionEngine.getMode() });
}

// Initialize with the default repo
initAgentInfra(REPO_ROOT);

// ── Store cache: keep one GraphStore per repo path, never close/reopen ──
// KuzuDB's native library crashes when closing a database and opening another
// one in the same process. To avoid this, we cache store instances per repo
// path and reuse them. The memory overhead is acceptable for a reasonable
// number of repos.
const storeCache = new Map<string, GraphStore>();
/** Repo paths whose KuzuDB database was opened at some point in this
 *  process. Once opened, a database's files must never be deleted —
 *  entries are never removed from this set. */
const openedDbPaths = new Set<string>();
/** Repo paths whose indexed data was deleted (or queued for deletion)
 *  during this session. Used so isIndexed reports them as unindexed
 *  even while deferred-deletion files are still on disk. */
const deletedPaths = new Set<string>();

/** Get or create a GraphStore for the given repo path. */
async function getStore(repoRoot: string): Promise<GraphStore> {
  let s = storeCache.get(repoRoot);
  if (!s) {
    s = new GraphStore(repoRoot);
    await s.init();
    storeCache.set(repoRoot, s);
    openedDbPaths.add(repoRoot);
  }
  return s;
}

// ── Helper: check if a repo has indexed data ──────────────────────

function isIndexed(repoRoot: string): boolean {
  if (deletedPaths.has(repoRoot)) return false;
  const graphDbPath = path.join(repoDataDir(repoRoot), 'graph.db');
  return fs.existsSync(graphDbPath);
}

/** Get node/edge counts from the current store (best-effort) */
async function getCounts(): Promise<{ nodeCount: number; edgeCount: number }> {
  try {
    const stats = await store.getStats();
    const nodeCount = Object.values(stats).reduce((a, b) => a + b, 0);
    const edges = await store.getAllEdges();
    return { nodeCount, edgeCount: edges.length };
  } catch {
    return { nodeCount: 0, edgeCount: 0 };
  }
}

// ── Endpoints ────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    repoRoot: REPO_ROOT,
    llmProvider: config.llmProvider,
    llmModel:
      config.llmProvider === 'omniroute'
        ? config.omnirouteModel
        : config.llmProvider === 'bedrock'
          ? config.bedrockModel
          : config.ollamaModel,
  });
});

/** List all known/indexed repos from the registry */
app.get('/api/repos', (_req, res) => {
  try {
    const repos = registry.list().map(r => ({
      ...r,
      // Verify the path still exists on disk
      exists: fs.existsSync(r.path),
    }));
    res.json({ repos, activeRepo: REPO_ROOT });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Remove a repo from the registry, optionally delete indexed data on disk */
app.delete('/api/repos', async (req, res) => {
  try {
    // Body is optional on DELETE — fall back to query params when absent.
    const parsed = removeRepoSchema.safeParse(req.body ?? {});
    let repoPath: string;
    let deleteData: boolean;
    if (parsed.success) {
      repoPath = parsed.data.repoRoot.trim();
      deleteData = parsed.data.deleteData === true;
    } else {
      // Allow query-string fallback for clients that don't send a body.
      repoPath = (req.query.repoRoot as string)?.trim() ?? '';
      deleteData = req.query.deleteData === 'true';
      if (!repoPath) {
        return res.status(400).json({ error: parsed.error.issues[0].message });
      }
    }
    const resolved = path.resolve(repoPath);

    registry.remove(resolved);

    const wasActiveRepo = resolved === REPO_ROOT;
    let deferredDeletion = false;

    if (deleteData) {
      // ⚠️ KuzuDB native crash risk: deleting the data dir while a
      // KuzuDB Database has it open kills the whole process — the native
      // library keeps file handles and WAL state on graph.db. So:
      //  - If this process ever opened a store for this repo, we orphan
      //    the store (never close it) and QUEUE the directory for
      //    deletion on the next startup instead of deleting it now.
      //  - If no store was ever opened for it this session, no handles
      //    exist and the directory can be removed immediately.
      const dataDir = repoDataDir(resolved);
      deletedPaths.add(resolved);

      if (openedDbPaths.has(resolved)) {
        // Keep the store in the cache — its files are still on disk, so
        // it stays fully usable, and re-ingesting/re-selecting this repo
        // must reuse it (opening a second KuzuDB Database on the same
        // path fails: the .lock file is already held).
        registry.queueDelete(dataDir);
        deferredDeletion = fs.existsSync(dataDir);
        // Loose files are written per-operation and hold no persistent
        // handles — safe to remove right away.
        for (const f of ['memory.json', 'audit-log.json', 'hash-cache.json']) {
          try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch {}
        }
      } else if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }

    if (wasActiveRepo) {
      // Stop the watcher for the deleted repo
      if (watcher) {
        watcher.stop();
        watcher = undefined as any;
      }

      // Find a surviving repo to switch to, or stay on current path
      const survivingRepos = registry.list().filter(r => r.path !== resolved && fs.existsSync(r.path));

      if (survivingRepos.length > 0) {
        REPO_ROOT = survivingRepos[0].path;
        store = await getStore(REPO_ROOT);
      } else if (deferredDeletion) {
        // Last repo removed and its graph.db files are still held open by
        // an orphaned store. Serve an ephemeral store under the app store
        // dir so every endpoint returns an empty graph WITHOUT recreating
        // .codebase-oracle/graph.db on disk — the queued deletion will
        // remove both directories on the next startup. (A kuzu ':memory:'
        // database is NOT used: it destabilizes the process when other
        // file-backed databases are open.)
        if (!fs.existsSync(config.storeDir)) fs.mkdirSync(config.storeDir, { recursive: true });
        const ephemeralDir = fs.mkdtempSync(path.join(config.storeDir, 'ephemeral-'));
        store = new GraphStore(REPO_ROOT, { dbPath: path.join(ephemeralDir, 'graph.db') });
        await store.init();
        registry.queueDelete(ephemeralDir);
      } else {
        // Repo entry removed but its data was never opened (or deleteData
        // was false) — keep serving the same on-disk store.
        store = await getStore(REPO_ROOT);
      }

      qa = new OllamaQA(store, { provider: buildLLMProvider(), systemPrompt: SYSTEM_PROMPT });

      // Re-initialize agent infra for the active repo
      initAgentInfra(REPO_ROOT, permissionEngine.getMode());

      // Start watcher for the new active repo (if it exists on disk)
      if (fs.existsSync(REPO_ROOT)) {
        watcher = new RepoWatcher(REPO_ROOT, store);
        watcher.onImpact((report) => { latestImpactReport = report; });
        watcher.start();
      }

      // Clear latest impact report
      latestImpactReport = null;
    }

    res.json({ success: true, switchedTo: wasActiveRepo ? REPO_ROOT : undefined, deferredDeletion });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get current repo root + indexed status */
app.get('/api/repo', async (_req, res) => {
  try {
    const indexed = isIndexed(REPO_ROOT);
    const hashCachePath = path.join(repoDataDir(REPO_ROOT), 'hash-cache.json');
    const hasHashCache = fs.existsSync(hashCachePath);
    const { nodeCount, edgeCount } = await getCounts();

    res.json({
      repoRoot: REPO_ROOT,
      indexed,
      hasHashCache,
      nodeCount,
      edgeCount,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Switch the active repo. Uses cached store instances — no close/reopen
 * (that crashes KuzuDB's native library). The repo is marked as known
 * in the registry so it appears in the repo list.
 */
app.post('/api/repo', async (req, res) => {
  const parsed = setRepoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const body = parsed.data;
  const resolved = path.resolve(body.repoRoot.trim());
  if (!fs.existsSync(resolved)) {
    return res.status(400).json({ error: `Path does not exist: ${resolved}` });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: `Path is not a directory: ${resolved}` });
  }

  // If this repo's data deletion was deferred earlier this session, the
  // files are still on disk — selecting it again cancels the pending
  // delete and reopens the existing database.
  const cancelPendingDelete = deletedPaths.has(resolved);

  // No-op if already on this repo (unless a deferred delete must be undone)
  if (resolved === REPO_ROOT && store && !cancelPendingDelete) {
    const indexed = isIndexed(REPO_ROOT);
    const { nodeCount, edgeCount } = await getCounts();
    return res.json({
      success: true,
      repoRoot: REPO_ROOT,
      indexed,
      nodeCount,
      edgeCount,
    });
  }

  try {
    // Stop old watcher
    if (watcher) watcher.stop();

    // Switch to new repo — use cached store (no close/reopen!)
    REPO_ROOT = resolved;
    registry.markKnown(REPO_ROOT);
    if (cancelPendingDelete) {
      registry.unqueueDelete(repoDataDir(resolved));
      deletedPaths.delete(resolved);
      // The cached on-disk store is reused — a second KuzuDB Database on
      // the same path can't be opened while the first holds the lock.
    }
    store = await getStore(REPO_ROOT);
    qa = new OllamaQA(store, { provider: buildLLMProvider(), systemPrompt: SYSTEM_PROMPT });

    // Phase 3: Re-initialize agent infrastructure for the new repo
    initAgentInfra(REPO_ROOT, permissionEngine.getMode());

    // Start watcher for new repo
    watcher = new RepoWatcher(REPO_ROOT, store);
    watcher.onImpact((report) => { latestImpactReport = report; });
    watcher.start();

    const indexed = isIndexed(REPO_ROOT);
    const { nodeCount, edgeCount } = await getCounts();

    res.json({
      success: true,
      repoRoot: REPO_ROOT,
      indexed,
      nodeCount,
      edgeCount,
    });
  } catch (err: any) {
    console.error('💥 Repo switch error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger full or incremental ingestion.
 * Uses the server's existing store — no close/reopen (that crashes KuzuDB).
 * If `repoRoot` is provided and differs from the active repo, switches first.
 */
app.post('/api/ingest', async (req, res) => {
  try {
    const parsed = ingestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const incremental = body.incremental !== false;
    const full = body.full === true;
    const requestedRepo = body.repoRoot?.trim();
    const targetRepo = requestedRepo ? path.resolve(requestedRepo) : REPO_ROOT;

    if (!fs.existsSync(targetRepo) || !fs.statSync(targetRepo).isDirectory()) {
      return res.status(400).json({ error: `Invalid repo path: ${targetRepo}` });
    }

    // Re-ingesting a repo whose data deletion was deferred: the old files
    // are still on disk. Cancel the pending delete, drop the ephemeral
    // in-memory store if it's the active one, and clear stale graph data
    // so the fresh index isn't merged with leftovers.
    const reIngestingDeleted = deletedPaths.has(targetRepo);

    // If ingest target differs from active repo, switch first (using cache)
    if (targetRepo !== REPO_ROOT || reIngestingDeleted) {
      if (watcher) watcher.stop();
      REPO_ROOT = targetRepo;
      registry.markKnown(REPO_ROOT);
      if (reIngestingDeleted) {
        registry.unqueueDelete(repoDataDir(targetRepo));
        deletedPaths.delete(targetRepo);
        // The cached on-disk store is reused — its files still exist, and
        // opening a second KuzuDB Database on the same path would fail on
        // the lock file.
      }
      store = await getStore(REPO_ROOT);
      if (reIngestingDeleted) {
        try {
          await store.runCypher('MATCH (a:CodeNode)-[r:CodeEdge]->() DELETE r');
          await store.runCypher('MATCH (n:CodeNode) DELETE n');
        } catch {}
      }
      qa = new OllamaQA(store, { provider: buildLLMProvider(), systemPrompt: SYSTEM_PROMPT });
      watcher = new RepoWatcher(REPO_ROOT, store);
      watcher.onImpact((report) => { latestImpactReport = report; });
      watcher.start();
    }

    // Pause watcher during ingest to avoid self-triggering
    if (watcher) watcher.stop();

    const useLlm = body.useLlmEnrichment === true;
    console.log(`📦 Ingest starting for: ${REPO_ROOT} (full=${full}, llm=${useLlm})`);

    // Use the server's existing store — no close/reopen
    const engine = new IngestEngine({
      repoRoot: REPO_ROOT,
      incremental: full ? false : incremental,
      store, // pass the existing store
      useLlmEnrichment: useLlm,
      llmProvider: useLlm ? buildLLMProvider() : undefined,
    });
    const result = await engine.run();
    console.log(`   ✓ Ingest done: ${result.filesProcessed} files, ${result.nodesCreated} nodes, ${result.edgesCreated} edges`);

    // Register the repo with updated stats
    registry.register(REPO_ROOT, {
      nodeCount: result.nodesCreated,
      edgeCount: result.edgesCreated,
      filesProcessed: result.filesProcessed,
    });

    // Recreate Q&A with fresh store data
    qa = new OllamaQA(store, { provider: buildLLMProvider(), systemPrompt: SYSTEM_PROMPT });

    // Restart watcher
    watcher = new RepoWatcher(REPO_ROOT, store);
    watcher.onImpact((report) => { latestImpactReport = report; });
    watcher.start();

    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('💥 Ingest error:', err);
    // Restart watcher even on error
    try {
      watcher = new RepoWatcher(REPO_ROOT, store);
      watcher.onImpact((report) => { latestImpactReport = report; });
      watcher.start();
    } catch {}
    res.status(500).json({ error: err.message });
  }
});

/** Get all nodes for graph visualization */
app.get('/api/graph', async (_req, res) => {
  try {
    const nodes = await store.getAllNodes();
    const edges = await store.getAllEdges();
    res.json({ nodes, edges });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get codebase statistics */
app.get('/api/stats', async (_req, res) => {
  try {
    const stats = await store.getStats();
    const patterns = await store.getNodesByKind('ArchPattern');
    const endpoints = await store.getNodesByKind('APIEndpoint');
    res.json({ stats, patterns, endpoints });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Search nodes */
app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ error: 'Missing query parameter ?q=' });
    const results = await store.search(q);
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get a single node + its neighborhood */
app.get('/api/node/:id', async (req, res) => {
  try {
    const node = await store.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const neighborhood = await store.getNeighborhood(req.params.id, 2);
    res.json({ node, neighborhood });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get nodes by file path */
app.get('/api/file', async (req, res) => {
  try {
    const fp = req.query.path as string;
    if (!fp) return res.status(400).json({ error: 'Missing ?path=' });
    const nodes = await store.getNodesByFile(fp);
    res.json({ nodes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Impact analysis for a set of changed files */
app.post('/api/impact', async (req, res) => {
  try {
    const parsed = impactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const changes: ChangedItem[] = body.changes;
    const useLlm = body.useLlm === true;
    const analyzer = new ImpactAnalyzer(store);
    const report = await analyzer.analyzeChanges(changes);

    // Optional LLM enrichment
    if (useLlm) {
      try {
        const { enrichImpactAnalysis } = await import('../llm/enrichment.js');
        const provider = buildLLMProvider();
        console.log('🧠 LLM impact enrichment running...');
        const llmEnrichment = await enrichImpactAnalysis(provider, report, REPO_ROOT);
        (report as any).llmEnrichment = llmEnrichment;
        console.log('   ✓ LLM impact enrichment done');
      } catch (err: any) {
        console.warn(`⚠ LLM impact enrichment failed: ${err.message}`);
        (report as any).llmEnrichment = {
          explanation: `LLM enrichment failed: ${err.message}`,
          severityAssessments: [],
          testSuggestions: [],
        };
      }
    }

    latestImpactReport = report;
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get latest impact report from file watcher */
app.get('/api/impact/latest', (_req, res) => {
  res.json(latestImpactReport ?? { message: 'No changes detected yet' });
});

/** Ask a question about the codebase */
app.post('/api/ask', async (req, res) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const question = body.question;
    const result = await qa.ask(question);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Ask a question with the agentic engine — streaming SSE response.
 *
 * This is the Phase 2 agentic endpoint. It uses the AgentEngine to run
 * an iterative tool-using loop, streaming events (assistant text deltas,
 * tool calls, tool results) to the client as they happen.
 *
 * If the provider doesn't support tool-calling, the engine falls back
 * to single-shot chat and emits the answer as a single delta.
 *
 * The client consumes Server-Sent Events: each `data:` line is a JSON
 * agent event. The stream ends after a `turn_end` event.
 */
app.post('/api/ask/stream', async (req, res) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const question = body.question;

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Build the agent engine with the current store + provider + Phase 3 infra
    const provider = buildLLMProvider();
    const engineId = `engine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const engine = new AgentEngine({
      provider,
      toolContext: { store, repoRoot: REPO_ROOT },
      maxIterations: config.agentMaxIterations,
      systemPromptOverride: SYSTEM_PROMPT,
      memory: memoryStore,
      audit: auditStore,
      permissions: permissionEngine,
      tokenBudget: config.agentTokenBudget,
    });
    activeEngines.set(engineId, engine);

    const log = logger.child('ask-stream');

    // Drive the turn and stream events
    for await (const event of engine.run(question)) {
      res.write(eventToSSE(event));

      // Log tool activity for observability
      if (event.type === EventType.TOOL_PROPOSED) {
        log.info('Tool calls proposed', { tools: event.toolCalls.map(tc => tc.function.name) });
      } else if (event.type === EventType.TOOL_FINISHED) {
        log.info('Tool finished', { tool: event.toolName, success: event.success, ms: event.durationMs });
      } else if (event.type === EventType.TURN_END) {
        log.info('Turn ended', { iterations: event.iterations, toolCalls: event.toolCallsMade, fallback: event.fallback });
      } else if (event.type === EventType.ERROR) {
        log.error('Turn error', { message: event.message });
      } else if (event.type === EventType.COMPACTION) {
        log.info('Context compacted', { removed: event.messagesRemoved, tokensSaved: event.tokensSaved });
      } else if (event.type === EventType.MEMORY_SAVED) {
        log.info('Memory saved', { id: event.memoryId, scope: event.scope });
      } else if (event.type === EventType.PERMISSION_REQUIRED) {
        log.info('Permission required', { tool: event.toolName, reason: event.reason });
      }
    }

    activeEngines.delete(engineId);
    res.end();
  } catch (err: any) {
    logger.error('ask/stream error', { error: err.message });
    // If headers not sent yet, send a JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      // Stream already started — send error as an SSE event then close
      try {
        res.write(eventToSSE({
          type: EventType.ERROR,
          seq: -1,
          timestamp: new Date().toISOString(),
          message: err.message,
          recoverable: false,
        } as any));
      } catch {}
      res.end();
    }
  }
});

/**
 * Resolve a pending permission request from the UI.
 * The client sends the engine ID and tool call ID along with the decision.
 */
app.post('/api/permission/resolve', (req, res) => {
  try {
    const parsed = permissionResolveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { engineId, toolCallId, decision, reason } = parsed.data;
    const engine = activeEngines.get(engineId);
    if (!engine) {
      return res.status(404).json({ error: 'Engine not found (it may have completed already)' });
    }
    engine.resolvePermission(toolCallId, decision, reason);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get or set the current permission mode.
 */
app.get('/api/permission/mode', (_req, res) => {
  res.json({ mode: permissionEngine.getMode(), description: modeDescription(permissionEngine.getMode()) });
});

app.post('/api/permission/mode', (req, res) => {
  try {
    const parsed = permissionModeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { mode } = parsed.data;
    permissionEngine.setMode(mode);
    res.json({ mode: permissionEngine.getMode(), description: modeDescription(permissionEngine.getMode()) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 3: Memory API ────────────────────────────────────────────

/** List all memory items. */
app.get('/api/memory', async (_req, res) => {
  try {
    const items = await memoryStore.list();
    res.json({ items, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Add a memory item manually (not via the agent). */
app.post('/api/memory', async (req, res) => {
  try {
    const parsed = addMemorySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { content, scope, tags } = parsed.data;
    const item = await memoryStore.add(scope ?? 'workspace', content, tags);
    res.json({ success: true, item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Remove a memory item. */
app.delete('/api/memory/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const removed = await memoryStore.forget(id);
    res.json({ success: removed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Search memory items. */
app.get('/api/memory/search', async (req, res) => {
  try {
    const q = (req.query.q as string) ?? '';
    if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });
    const items = await memoryStore.search(q);
    res.json({ items, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Clear all memory items (optionally by scope). */
app.delete('/api/memory', async (req, res) => {
  try {
    const parsed = clearMemorySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { scope } = parsed.data;
    await memoryStore.clear(scope);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phase 3: Audit Log API ─────────────────────────────────────────

/** List recent audit entries. */
app.get('/api/audit', (_req, res) => {
  try {
    const entries = auditStore.list(100);
    res.json({ entries, count: entries.length, total: auditStore.count() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Clear the audit log. */
app.delete('/api/audit', (_req, res) => {
  try {
    auditStore.clear();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Run arbitrary Cypher query (power-user) */
app.post('/api/cypher', async (req, res) => {
  try {
    const parsed = cypherSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const { query, params } = parsed.data;
    const rows = await store.runCypher(query, params ?? {});
    res.json({ rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Filesystem browser (for folder picker) ────────────────────────

/**
 * List subdirectories at a given path for the folder picker UI.
 */
app.get('/api/browse', (req, res) => {
  try {
    const requestedPath = (req.query.path as string)?.trim();

    let browsePath: string;
    if (!requestedPath) {
      if (process.platform === 'win32') {
        const drives: { name: string; path: string; hasSubdirs: boolean }[] = [];
        for (let code = 65; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = `${letter}:\\`;
          if (fs.existsSync(drivePath)) {
            try {
              const entries = fs.readdirSync(drivePath, { withFileTypes: true });
              const hasSubdirs = entries.some(e => e.isDirectory());
              drives.push({ name: `${letter}:`, path: drivePath, hasSubdirs });
            } catch {}
          }
        }
        return res.json({ path: '', parent: null, dirs: drives, isRoot: true });
      } else {
        browsePath = process.env.HOME || process.env.USERPROFILE || '/';
      }
    } else {
      browsePath = path.resolve(requestedPath);
    }

    if (!fs.existsSync(browsePath)) {
      return res.status(400).json({ error: `Path does not exist: ${browsePath}` });
    }
    const stat = fs.statSync(browsePath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${browsePath}` });
    }

    const entries = fs.readdirSync(browsePath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .filter(e => !e.name.startsWith('.') || e.name === '.')
      .map(e => {
        const dirPath = path.join(browsePath, e.name);
        let hasSubdirs = false;
        try {
          const subEntries = fs.readdirSync(dirPath, { withFileTypes: true });
          hasSubdirs = subEntries.some(s => s.isDirectory());
        } catch {}
        return { name: e.name, path: dirPath, hasSubdirs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(browsePath);
    const isRoot = parent === browsePath;

    res.json({ path: browsePath, parent: isRoot ? null : parent, dirs, isRoot });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Documentation generation ──────────────────────────────────────

app.get('/api/docs/generate', async (req, res) => {
  try {
    const format: DocFormat = req.query.format === 'html' ? 'html' : 'md';
    const catsQuery = req.query.categories as string;
    const categories = catsQuery ? catsQuery.split(',').map(c => c.trim() as DocCategory) : undefined;
    const includeLlmSummary = req.query.llm === 'true' || req.query.includeLlmSummary === 'true';

    const provider = includeLlmSummary ? buildLLMProvider() : undefined;
    const result = await generateDocs(store, REPO_ROOT, { format, categories, includeLlmSummary, provider });
    const mimeType = format === 'html' ? 'text/html' : 'text/markdown';
    res.setHeader('Content-Type', `${mimeType}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.content);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docs/preview', async (req, res) => {
  try {
    const format: DocFormat = req.query.format === 'html' ? 'html' : 'md';
    const catsQuery = req.query.categories as string;
    const categories = catsQuery ? catsQuery.split(',').map(c => c.trim() as DocCategory) : undefined;
    const includeLlmSummary = req.query.llm === 'true' || req.query.includeLlmSummary === 'true';

    const provider = includeLlmSummary ? buildLLMProvider() : undefined;
    const result = await generateDocs(store, REPO_ROOT, { format, categories, includeLlmSummary, provider });
    res.json({ content: result.content, format: result.format, filename: result.filename });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Requirement-Based Impact & Implementation Plan Analysis
 * Maps a natural language requirement or developer question to:
 *  - Semantic concept & intent recognition
 *  - Matched code entities & target files
 *  - Blast radius & transitive dependencies
 *  - Call-graph performance bottlenecks & hotspots
 *  - Step-by-step technical implementation plan
 *  - Optional deep LLM enrichment
 */
app.post('/api/requirement-impact', async (req, res) => {
  try {
    const parsed = requirementImpactSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
    const body = parsed.data;
    const requirement = body.requirement.trim();
    const useLlm = body.useLlm === true;

    const analyzer = new RequirementAnalyzer(store);
    const result = await analyzer.analyze(requirement);

    // Deep LLM enrichment if requested
    if (useLlm) {
      try {
        console.log('🧠 LLM requirement enrichment & plan generation running...');
        const provider = buildLLMProvider();
        const llmEnrichment = await enrichRequirementImpact(provider, {
          requirement,
          detectedIntents: result.detectedIntents,
          matchedEntities: result.matchedEntities,
          impactedEntities: result.impactedEntities,
          affectedEndpoints: result.affectedEndpoints,
          performanceBottlenecks: result.performanceBottlenecks,
          riskScore: result.riskScore,
        }, REPO_ROOT);
        result.llmEnrichment = llmEnrichment;

        // If LLM produced a rich implementation plan, use it (or merge with deterministic plan)
        if (llmEnrichment.implementationPlan && llmEnrichment.implementationPlan.length > 0) {
          result.implementationPlan = llmEnrichment.implementationPlan;
        }
        console.log('   ✓ LLM requirement enrichment done');
      } catch (llmErr: any) {
        console.warn('⚠ LLM requirement enrichment failed:', llmErr.message);
        result.llmEnrichment = {
          explanation: `LLM requirement analysis failed: ${llmErr.message}. Displaying deterministic graph analysis.`,
          implementationPlan: result.implementationPlan,
          bottleneckAnalysis: 'LLM bottleneck analysis unavailable.',
          severityAssessments: [],
          testSuggestions: [],
        };
      }
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server startup ───────────────────────────────────────────────

async function main() {
  console.log(`\n🔮 Codebase Oracle — starting for repo: ${REPO_ROOT}\n`);

  // Initialize graph store (cached)
  store = await getStore(REPO_ROOT);

  // Initialize Q&A
  qa = new OllamaQA(store, { provider: buildLLMProvider(), systemPrompt: SYSTEM_PROMPT });

  // Mark the startup repo as known in the registry
  registry.markKnown(REPO_ROOT);

  // Start file watcher
  watcher = new RepoWatcher(REPO_ROOT, store);
  watcher.onImpact((report) => {
    latestImpactReport = report;
  });
  watcher.start();

  // Serve static frontend in production (when frontend/dist exists).
  const frontendDist = path.join(import.meta.dirname, '../../frontend/dist');
  const indexHtml = path.join(frontendDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) => {
      res.sendFile(indexHtml);
    });
  } else {
    app.get('*', (_req, res) => {
      res.status(404).json({
        error: 'Frontend not built. Run "npm run frontend" in a separate terminal for the dev dashboard, or build it with "cd frontend && npm run build".',
      });
    });
  }

  app.listen(PORT, () => {
    console.log(`🌐 API server:   http://localhost:${PORT}`);
    console.log(`📊 Dashboard:    http://localhost:${PORT}`);
    console.log(`📡 API docs:     http://localhost:${PORT}/api/health`);
    console.log(`\nRun "npm run ingest" first if this is a fresh repo.\n`);
  });
}

main().catch(console.error);
