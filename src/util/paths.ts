/**
 * Path helpers for app-level storage.
 *
 * All per-repo index data (graph.db, hash-cache.json, workspace
 * memory.json, audit-log.json) lives under the configured store dir
 * rather than inside the analyzed repository. Each repo gets a stable
 * directory keyed by a hash of its absolute path, so nothing is written
 * into the repo being indexed and the data location is independent of
 * any user home directory.
 */

import crypto from 'crypto';
import path from 'path';
import { config } from '../config.js';

/**
 * Directory holding all index data for a repo:
 * `<storeDir>/repos/<basename>-<hash>`
 *
 * The hash is of the resolved absolute path (lowercased on Windows where
 * paths are case-insensitive) so different repos never collide while the
 * basename keeps the directory human-readable.
 */
export function repoDataDir(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const norm = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  return path.join(config.storeDir, 'repos', `${base}-${hash}`);
}

/**
 * If the app store dir lives inside the given repo root, returns a
 * repo-relative glob pattern (e.g. "store/**") suitable for watcher /
 * ingest ignore lists. Returns null when the store dir is outside the
 * repo — the common case — so nothing needs excluding.
 */
export function storeDirPatternInside(repoRoot: string): string | null {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(config.storeDir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `${rel.replace(/\\/g, '/')}/**`;
}
