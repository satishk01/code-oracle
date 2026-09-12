/**
 * JSON-File Memory Store
 *
 * A file-backed implementation of {@link MemoryStore}. Stores memory items
 * in a JSON file at `<repoDataDir>/memory.json` (for workspace scope)
 * and `<storeDir>/memory.json` (for global scope).
 *
 * Session-scoped memory is in-memory only (not persisted).
 */

import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';
import { repoDataDir } from '../../util/paths.js';
import {
  MemoryStore,
  MemoryItem,
  MemoryScope,
  MEMORY_INDEX_THRESHOLD,
} from './store.js';
import { logger } from '../../util/logger.js';

const log = logger.child('memory-store');

export class JsonMemoryStore implements MemoryStore {
  private workspacePath: string;
  private globalPath: string;
  private sessionItems: MemoryItem[] = [];
  private nextId = 1;

  constructor(repoRoot: string) {
    // Workspace memory: <repoDataDir>/memory.json
    const wsDir = repoDataDir(repoRoot);
    this.workspacePath = path.join(wsDir, 'memory.json');
    // Global memory: <storeDir>/memory.json
    const globalDir = config.storeDir;
    this.globalPath = path.join(globalDir, 'memory.json');

    // Ensure directories exist
    this.ensureDir(wsDir);
    this.ensureDir(globalDir);

    // Load next ID from existing items
    this.refreshNextId();
  }

  async add(scope: MemoryScope, content: string, tags?: string[]): Promise<MemoryItem> {
    const item: MemoryItem = {
      id: this.nextId++,
      scope,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      tags: tags?.length ? tags : undefined,
    };

    if (scope === 'session') {
      this.sessionItems.push(item);
    } else {
      const items = this.loadFile(scope);
      items.push(item);
      this.saveFile(scope, items);
    }

    log.debug(`Memory added [${scope}]: ${item.content.slice(0, 60)}…`);
    return item;
  }

  async forget(id: number): Promise<boolean> {
    // Check session
    const sIdx = this.sessionItems.findIndex(i => i.id === id);
    if (sIdx >= 0) {
      this.sessionItems.splice(sIdx, 1);
      return true;
    }
    // Check workspace + global
    for (const scope of ['workspace', 'global'] as MemoryScope[]) {
      const items = this.loadFile(scope);
      const idx = items.findIndex(i => i.id === id);
      if (idx >= 0) {
        items.splice(idx, 1);
        this.saveFile(scope, items);
        return true;
      }
    }
    return false;
  }

  async list(scope?: MemoryScope): Promise<MemoryItem[]> {
    const all: MemoryItem[] = [];
    if (!scope || scope === 'global') all.push(...this.loadFile('global'));
    if (!scope || scope === 'workspace') all.push(...this.loadFile('workspace'));
    if (!scope || scope === 'session') all.push(...this.sessionItems);
    return all.sort((a, b) => a.id - b.id);
  }

  async search(query: string): Promise<MemoryItem[]> {
    const all = await this.list();
    const q = query.toLowerCase();
    return all.filter(item =>
      item.content.toLowerCase().includes(q) ||
      item.tags?.some(t => t.toLowerCase().includes(q))
    );
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (!scope || scope === 'session') this.sessionItems = [];
    if (!scope || scope === 'workspace') this.saveFile('workspace', []);
    if (!scope || scope === 'global') this.saveFile('global', []);
  }

  async buildContext(maxChars: number = MEMORY_INDEX_THRESHOLD): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return '';

    const fullContent = all.map(i => {
      const tags = i.tags?.length ? ` [${i.tags.join(', ')}]` : '';
      return `[${i.scope}] #${i.id}: ${i.content}${tags}`;
    }).join('\n');

    if (fullContent.length <= maxChars) {
      return `## Agent Memory\nThe following facts have been remembered about this codebase:\n${fullContent}`;
    }

    // Index mode: show only summaries
    const summaries = all.map(i => {
      const firstLine = i.content.split('\n')[0].slice(0, 80);
      const tags = i.tags?.length ? ` [${i.tags.join(', ')}]` : '';
      return `#${i.id} [${i.scope}]${tags}: ${firstLine}…`;
    }).join('\n');

    return `## Agent Memory (Index Mode)\nThere are ${all.length} memory items. Use the search_memory tool to find specific items.\n${summaries}`;
  }

  async close(): Promise<void> {
    // Nothing to close for file-based store
  }

  // ── File helpers ──────────────────────────────────────────────────

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
  }

  private loadFile(scope: MemoryScope): MemoryItem[] {
    if (scope === 'session') return this.sessionItems;
    const filePath = scope === 'global' ? this.globalPath : this.workspacePath;
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = fs.readFileSync(filePath, 'utf-8');
      const items = JSON.parse(data) as MemoryItem[];
      return Array.isArray(items) ? items : [];
    } catch (err: any) {
      log.warn(`Failed to load memory file: ${filePath}`, { error: err.message });
      return [];
    }
  }

  private saveFile(scope: MemoryScope, items: MemoryItem[]): void {
    if (scope === 'session') { this.sessionItems = items; return; }
    const filePath = scope === 'global' ? this.globalPath : this.workspacePath;
    try {
      fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
    } catch (err: any) {
      log.warn(`Failed to save memory file: ${filePath}`, { error: err.message });
    }
  }

  private refreshNextId(): void {
    const all = [
      ...this.loadFile('global'),
      ...this.loadFile('workspace'),
      ...this.sessionItems,
    ];
    const maxId = all.reduce((max, i) => Math.max(max, i.id), 0);
    this.nextId = maxId + 1;
  }
}
