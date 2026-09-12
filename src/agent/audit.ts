/**
 * Audit Log
 *
 * Records every tool call, its arguments (secrets redacted), result,
 * approval status, and timestamp. Makes agent actions explainable and
 * reproducible.
 *
 * Inspired by OpenWorker's `coworker/audit.py` — SQLite audit log with
 * secret redaction. Implementation: JSON-file-backed to avoid adding a
 * native SQLite dependency.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../util/logger.js';
import { repoDataDir } from '../util/paths.js';

const log = logger.child('audit');

export interface AuditEntry {
  /** Unique entry ID (monotonic). */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** The agent name that initiated the turn. */
  agent: string;
  /** Tool name that was called. */
  toolName: string;
  /** Tool call ID (from the LLM). */
  toolCallId: string;
  /** Arguments passed to the tool (JSON, secrets redacted). */
  args: string;
  /** Whether the tool succeeded. */
  success: boolean;
  /** Result (truncated, secrets redacted). */
  result: string;
  /** Error message if the tool failed. */
  error?: string;
  /** Execution time in ms. */
  durationMs: number;
  /** Permission decision: "auto-allowed", "approved", "denied". */
  permission: 'auto-allowed' | 'approved' | 'denied';
  /** The question that initiated the turn. */
  question: string;
}

/** Patterns that look like secrets — redacted in args/results. */
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,}]+["']?/gi,
  /Bearer\s+[A-Za-z0-9\-._~+\/]+=*/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /oma_live_[A-Za-z0-9]+/g,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export class AuditStore {
  private filePath: string;
  private entries: AuditEntry[] = [];
  private nextId = 1;
  private maxEntries: number;

  constructor(repoRoot: string, maxEntries: number = 1000) {
    const dir = repoDataDir(repoRoot);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    this.filePath = path.join(dir, 'audit-log.json');
    this.maxEntries = maxEntries;
    this.load();
  }

  /** Record a tool call in the audit log. */
  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      args: redactSecrets(entry.args),
      result: redactSecrets(entry.result).slice(0, 4000),
    };
    this.entries.push(full);

    // Trim if exceeding max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    this.save();
    log.debug(`Audit recorded: ${full.toolName} (${full.permission})`);
    return full;
  }

  /** List audit entries, most recent first. */
  list(limit: number = 50): AuditEntry[] {
    return [...this.entries].reverse().slice(0, limit);
  }

  /** List audit entries for a specific tool. */
  byTool(toolName: string, limit: number = 50): AuditEntry[] {
    return this.entries.filter(e => e.toolName === toolName).reverse().slice(0, limit);
  }

  /** Clear all audit entries. */
  clear(): void {
    this.entries = [];
    this.save();
  }

  /** Get total entry count. */
  count(): number {
    return this.entries.length;
  }

  // ── File helpers ──────────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = fs.readFileSync(this.filePath, 'utf-8');
      const entries = JSON.parse(data) as AuditEntry[];
      if (Array.isArray(entries)) {
        this.entries = entries;
        this.nextId = entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
      }
    } catch (err: any) {
      log.warn(`Failed to load audit log: ${this.filePath}`, { error: err.message });
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err: any) {
      log.warn(`Failed to save audit log: ${this.filePath}`, { error: err.message });
    }
  }
}
