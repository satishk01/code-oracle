/**
 * File Watcher
 *
 * Monitors the repo for file changes using chokidar, triggers
 * incremental re-ingestion and impact analysis.
 */

import chokidar, { FSWatcher } from 'chokidar';
import path from 'path';
import { IngestEngine } from '../parsers/ingest.js';
import { ImpactAnalyzer, ChangedItem, ImpactReport } from './impact.js';
import { GraphStore } from '../graph/store.js';
import { storeDirPatternInside } from '../util/paths.js';

export type ChangeCallback = (report: ImpactReport) => void;

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  private pendingChanges: Map<string, ChangedItem> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: ChangeCallback[] = [];
  private processing = false;

  constructor(
    private repoRoot: string,
    private store: GraphStore,
    private debounceMs: number = 2000,
  ) {}

  onImpact(cb: ChangeCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    const ignore = [
      '**/node_modules/**', '**/.git/**', '**/.codebase-oracle/**',
      '**/dist/**', '**/build/**',
    ];
    // Ignore the app store dir when it lives inside the watched repo —
    // otherwise graph.db/memory writes would self-trigger re-ingests.
    const storePattern = storeDirPatternInside(this.repoRoot);
    if (storePattern) ignore.push(storePattern);

    this.watcher = chokidar.watch(this.repoRoot, {
      ignored: ignore,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('change', (fp: string) => this.queueChange(fp, 'modified'))
      .on('add', (fp: string) => this.queueChange(fp, 'added'))
      .on('unlink', (fp: string) => this.queueChange(fp, 'deleted'));

    console.log(`👁  Watching ${this.repoRoot} for changes...`);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
  }

  private queueChange(absPath: string, type: ChangedItem['type']): void {
    if (!/\.(ts|tsx|js|jsx|json)$/.test(absPath)) return;

    const relPath = path.relative(this.repoRoot, absPath);
    this.pendingChanges.set(relPath, { filePath: relPath, type });

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processBatch(), this.debounceMs);
  }

  private async processBatch(): Promise<void> {
    if (this.processing) return; // prevent concurrent re-ingest
    this.processing = true;

    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();

    if (changes.length === 0) {
      this.processing = false;
      return;
    }

    console.log(`\n🔄 Detected ${changes.length} change(s), re-ingesting...`);

    try {
      // Re-ingest changed files into the shared store — opening a second
      // KuzuDB database on the same path (and closing it) can crash the
      // native library, so we never create a store here.
      const ingest = new IngestEngine({
        repoRoot: this.repoRoot,
        incremental: true,
        store: this.store,
      });
      const stats = await ingest.run();
      console.log(`   ✓ ${stats.filesProcessed} files, ${stats.nodesCreated} nodes, ${stats.edgesCreated} edges`);

      const analyzer = new ImpactAnalyzer(this.store);
      const report = await analyzer.analyzeChanges(changes);

      console.log(`   ✓ Impact: risk=${report.riskScore}/100, ${report.directImpacts.length} direct, ${report.transitiveImpacts.length} transitive`);

      for (const cb of this.callbacks) {
        cb(report);
      }
    } catch (err: any) {
      console.error(`   ✗ Error: ${err.message}`);
    } finally {
      this.processing = false;
    }
  }
}
