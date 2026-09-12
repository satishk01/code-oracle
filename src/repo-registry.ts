/**
 * Repository Registry
 *
 * Tracks all repositories that have been indexed by Codebase Oracle.
 * The registry persists to a JSON file in the user's home directory so
 * it survives server restarts and can list every known repo.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from './config.js';
import { repoDataDir } from './util/paths.js';

export interface RepoEntry {
  /** Absolute path to the repository root */
  path: string;
  /** Repository folder name (for display) */
  name: string;
  /** Timestamp of last indexing (ISO string) */
  lastIndexed: string | null;
  /** Node count at last indexing */
  nodeCount: number;
  /** Edge count at last indexing */
  edgeCount: number;
  /** Files processed at last indexing */
  filesProcessed: number;
}

export class RepoRegistry {
  private registryPath: string;
  private pendingDeletePath: string;
  private repos: Map<string, RepoEntry> = new Map();

  constructor() {
    // App-level data lives under the configured store dir
    // (default: <cwd>/store) — no dependency on a user home directory.
    const dir = config.storeDir;
    this.registryPath = path.join(dir, 'repos.json');
    this.pendingDeletePath = path.join(dir, 'pending-delete.json');
    this.load();
  }

  private load(): void {
    try {
      let data: unknown = null;
      if (fs.existsSync(this.registryPath)) {
        data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      } else {
        // One-time import of the pre-store-dir registry location
        const legacy = path.join(os.homedir(), '.codebase-oracle', 'repos.json');
        if (fs.existsSync(legacy)) {
          data = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
        }
      }
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry.path) this.repos.set(entry.path, entry);
        }
      }
    } catch {
      // Corrupt or missing registry — start fresh
    }
  }

  private save(): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Array.from(this.repos.values());
    fs.writeFileSync(this.registryPath, JSON.stringify(data, null, 2));
  }

  /** Get all registered repos, sorted by name */
  list(): RepoEntry[] {
    return Array.from(this.repos.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Get a specific repo entry by path */
  get(repoPath: string): RepoEntry | null {
    return this.repos.get(repoPath) ?? null;
  }

  /** Check if a repo is in the registry (may or may not be indexed) */
  has(repoPath: string): boolean {
    return this.repos.has(repoPath);
  }

  /** Register or update a repo after indexing */
  register(repoPath: string, stats: {
    nodeCount: number;
    edgeCount: number;
    filesProcessed: number;
  }): void {
    const existing = this.repos.get(repoPath);
    this.repos.set(repoPath, {
      path: repoPath,
      name: path.basename(repoPath),
      lastIndexed: new Date().toISOString(),
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      filesProcessed: stats.filesProcessed,
    });
    this.save();
  }

  /** Mark a repo as known but not yet indexed (e.g. when user selects it) */
  markKnown(repoPath: string): void {
    if (!this.repos.has(repoPath)) {
      this.repos.set(repoPath, {
        path: repoPath,
        name: path.basename(repoPath),
        lastIndexed: null,
        nodeCount: 0,
        edgeCount: 0,
        filesProcessed: 0,
      });
      this.save();
    }
  }

  /** Remove a repo from the registry */
  remove(repoPath: string): void {
    if (this.repos.delete(repoPath)) {
      this.save();
    }
  }

  /**
   * Move pre-existing per-repo `.codebase-oracle` directories into the
   * store dir (one-time migration to the centralized layout). Safe only
   * before any store is opened — call at startup, never while a KuzuDB
   * database could have the files open.
   */
  migrateLegacyData(): void {
    for (const entry of this.repos.values()) {
      try {
        const legacy = path.join(entry.path, '.codebase-oracle');
        const target = repoDataDir(entry.path);
        if (!fs.existsSync(legacy) || fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.renameSync(legacy, target);
        } catch {
          // Cross-device move — copy then remove
          fs.cpSync(legacy, target, { recursive: true });
          fs.rmSync(legacy, { recursive: true, force: true });
        }
      } catch {
        // Leave the directory in place — worst case the repo is re-ingested
      }
    }
  }

  // ── Deferred .codebase-oracle deletion ──────────────────────────
  // KuzuDB keeps native file handles open on graph.db for the whole
  // process lifetime (stores are intentionally never closed). Deleting
  // those files while open can abort the native library and kill the
  // process, so directories that were opened this session are queued
  // here and physically removed on the next startup instead.

  /** Queue a .codebase-oracle directory for deletion at next startup. */
  queueDelete(oracleDir: string): void {
    const pending = this.pendingDeletes();
    if (!pending.includes(oracleDir)) {
      pending.push(oracleDir);
      this.savePendingDeletes(pending);
    }
  }

  /** Remove a directory from the pending-delete queue (e.g. repo re-indexed). */
  unqueueDelete(oracleDir: string): void {
    this.savePendingDeletes(this.pendingDeletes().filter(d => d !== oracleDir));
  }

  /** Directories currently queued for deletion. */
  pendingDeletes(): string[] {
    try {
      if (fs.existsSync(this.pendingDeletePath)) {
        const data = JSON.parse(fs.readFileSync(this.pendingDeletePath, 'utf-8'));
        if (Array.isArray(data)) return data.filter(d => typeof d === 'string');
      }
    } catch {
      // Corrupt or missing queue — treat as empty
    }
    return [];
  }

  /**
   * Physically delete every queued directory. Only safe while no KuzuDB
   * database is open in this process — call before the first GraphStore
   * is created, and again on process exit when handles may be released.
   * Entries that fail to delete stay queued for the next run.
   */
  drainPendingDeletes(): void {
    const remaining: string[] = [];
    for (const dir of this.pendingDeletes()) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        remaining.push(dir);
      }
    }
    this.savePendingDeletes(remaining);
  }

  private savePendingDeletes(dirs: string[]): void {
    try {
      const dir = path.dirname(this.pendingDeletePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.pendingDeletePath, JSON.stringify(dirs, null, 2));
    } catch {
      // Non-fatal — worst case the directory is cleaned up on a later run
    }
  }
}
