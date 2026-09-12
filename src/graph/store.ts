/**
 * KuzuDB Graph Store
 *
 * Wraps kuzu embedded graph DB for all read/write operations.
 * The DB lives under the app store dir (see repoDataDir) — nothing is
 * written into the analyzed repository.
 */

import kuzu from 'kuzu';
import path from 'path';
import fs from 'fs';
import { BaseNode, Edge, getNodeTableDDL, getEdgeTableDDL } from '../ontology/schema.js';
import { repoDataDir } from '../util/paths.js';

export class GraphStore {
  /**
   * Strong references to every live (unclosed) store. KuzuDB's native
   * objects must never be garbage-collected while other databases are
   * open — their finalizers corrupt the heap and abort the whole process
   * (observed as STATUS_HEAP_CORRUPTION). Stores are intentionally never
   * closed in the server, so pinning them costs nothing extra; close()
   * unpins so the wrapper can be collected once native resources are
   * properly released.
   */
  private static pinned = new Set<GraphStore>();

  private db!: kuzu.Database;
  private conn!: kuzu.Connection;
  private dbPath: string;

  constructor(repoRoot: string, opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath
      ?? path.join(repoDataDir(repoRoot), 'graph.db');
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new kuzu.Database(this.dbPath);
    this.conn = new kuzu.Connection(this.db);

    // Create schema
    await this._exec(getNodeTableDDL());
    await this._exec(getEdgeTableDDL());

    GraphStore.pinned.add(this);
  }

  // ── Node operations ──────────────────────────────────────────────

  async upsertNode(node: BaseNode): Promise<void> {
    const existing = await this.getNode(node.id);
    if (existing) {
      await this._exec(`
        MATCH (n:CodeNode {id: $id})
        SET n.kind = $kind,
            n.name = $name,
            n.qualifiedName = $qualifiedName,
            n.filePath = $filePath,
            n.startLine = $startLine,
            n.endLine = $endLine,
            n.fingerprint = $fingerprint,
            n.description = $description,
            n.metadata = $metadata
      `, {
        id: node.id, kind: node.kind, name: node.name,
        qualifiedName: node.qualifiedName, filePath: node.filePath,
        startLine: node.startLine, endLine: node.endLine,
        fingerprint: node.fingerprint, description: node.description,
        metadata: node.metadata,
      });
    } else {
      await this._exec(`
        CREATE (n:CodeNode {
          id: $id, kind: $kind, name: $name,
          qualifiedName: $qualifiedName, filePath: $filePath,
          startLine: $startLine, endLine: $endLine,
          fingerprint: $fingerprint, description: $description,
          metadata: $metadata
        })
      `, {
        id: node.id, kind: node.kind, name: node.name,
        qualifiedName: node.qualifiedName, filePath: node.filePath,
        startLine: node.startLine, endLine: node.endLine,
        fingerprint: node.fingerprint, description: node.description,
        metadata: node.metadata,
      });
    }
  }

  async getNode(id: string): Promise<BaseNode | null> {
    const result = await this._exec(
      `MATCH (n:CodeNode {id: $id}) RETURN n.*`, { id }
    );
    const rows = await this.resultToRows(result);
    return rows.length > 0 ? this.rowToNode(rows[0]) : null;
  }

  async deleteNodesByFile(filePath: string): Promise<void> {
    // Delete edges first (directed match — KuzuDB doesn't support DELETE
    // on undirected relationship patterns).
    await this._exec(`
      MATCH (a:CodeNode)-[r:CodeEdge]->(b:CodeNode)
      WHERE a.filePath = $fp OR b.filePath = $fp
      DELETE r
    `, { fp: filePath });
    await this._exec(`
      MATCH (n:CodeNode {filePath: $fp}) DELETE n
    `, { fp: filePath });
  }

  // ── Edge operations ──────────────────────────────────────────────

  async addEdge(edge: Edge): Promise<void> {
    await this._exec(`
      MATCH (a:CodeNode), (b:CodeNode)
      WHERE a.id = $src AND b.id = $dst
      CREATE (a)-[:CodeEdge {kind: $kind, weight: $weight, metadata: $meta}]->(b)
    `, {
      src: edge.fromId, dst: edge.toId,
      kind: edge.kind, weight: edge.weight,
      meta: edge.metadata,
    });
  }

  async deleteEdgesForNode(nodeId: string): Promise<void> {
    // Directed matches — KuzuDB doesn't support DELETE on undirected patterns
    await this._exec(`
      MATCH (a:CodeNode {id: $id})-[r:CodeEdge]->()
      DELETE r
    `, { id: nodeId });
    await this._exec(`
      MATCH ()-[r:CodeEdge]->(a:CodeNode {id: $id})
      DELETE r
    `, { id: nodeId });
  }

  // ── Query operations ─────────────────────────────────────────────

  async getAllNodes(): Promise<BaseNode[]> {
    const result = await this._exec(`MATCH (n:CodeNode) RETURN n.*`);
    const rows = await this.resultToRows(result);
    return rows.map(r => this.rowToNode(r));
  }

  async getAllEdges(): Promise<Edge[]> {
    const result = await this._exec(`
      MATCH (a:CodeNode)-[r:CodeEdge]->(b:CodeNode)
      RETURN a.id AS fromId, b.id AS toId, r.kind AS kind,
             r.weight AS weight, r.metadata AS metadata
    `);
    return this.resultToRows(result) as unknown as Edge[];
  }

  async getNodesByKind(kind: string): Promise<BaseNode[]> {
    const result = await this._exec(
      `MATCH (n:CodeNode) WHERE n.kind = $kind RETURN n.*`, { kind }
    );
    const rows = await this.resultToRows(result);
    return rows.map(r => this.rowToNode(r));
  }

  async getNodesByFile(filePath: string): Promise<BaseNode[]> {
    const result = await this._exec(
      `MATCH (n:CodeNode) WHERE n.filePath = $fp RETURN n.*`, { fp: filePath }
    );
    const rows = await this.resultToRows(result);
    return rows.map(r => this.rowToNode(r));
  }

  /** Neighbors within N hops — used for impact analysis */
  async getNeighborhood(nodeId: string, maxDepth: number = 3): Promise<{
    nodes: BaseNode[];
    edges: Edge[];
  }> {
    const nodesResult = await this._exec(`
      MATCH (start:CodeNode {id: $id})-[r:CodeEdge*1..${maxDepth}]-(neighbor:CodeNode)
      RETURN DISTINCT neighbor.*
    `, { id: nodeId });
    const edgesResult = await this._exec(`
      MATCH (start:CodeNode {id: $id})-[r:CodeEdge*1..${maxDepth}]-(neighbor:CodeNode)
      WITH start, neighbor
      MATCH (a:CodeNode)-[e:CodeEdge]->(b:CodeNode)
      WHERE (a.id = start.id OR a.id = neighbor.id)
        AND (b.id = start.id OR b.id = neighbor.id)
      RETURN DISTINCT a.id AS fromId, b.id AS toId, e.kind AS kind,
             e.weight AS weight, e.metadata AS metadata
    `, { id: nodeId });

    const nodeRows = await this.resultToRows(nodesResult);
    const edgeRows = await this.resultToRows(edgesResult);
    const origin = await this.getNode(nodeId);

    const nodes = nodeRows.map(r => this.rowToNode(r));
    if (origin) nodes.unshift(origin);

    return {
      nodes,
      edges: edgeRows as unknown as Edge[],
    };
  }

  /** Direct dependents of a node — who calls/imports/uses this? */
  async getDependents(nodeId: string): Promise<{ node: BaseNode; edgeKind: string }[]> {
    const result = await this._exec(`
      MATCH (dep:CodeNode)-[r:CodeEdge]->(target:CodeNode {id: $id})
      RETURN dep.*, r.kind AS edgeKind
    `, { id: nodeId });
    const rows = await this.resultToRows(result);
    return rows.map((r: any) => ({
      node: this.rowToNode(r),
      edgeKind: r.edgeKind || r['r.kind'] || 'UNKNOWN',
    }));
  }

  /** Full-text search on name/qualifiedName/description */
  async search(query: string): Promise<BaseNode[]> {
    const pattern = `%${query}%`;
    const result = await this._exec(`
      MATCH (n:CodeNode)
      WHERE n.name CONTAINS $q
         OR n.qualifiedName CONTAINS $q
         OR n.description CONTAINS $q
      RETURN n.*
      LIMIT 50
    `, { q: query });
    const rows = await this.resultToRows(result);
    return rows.map(r => this.rowToNode(r));
  }

  /** Aggregate stats */
  async getStats(): Promise<Record<string, number>> {
    const result = await this._exec(`
      MATCH (n:CodeNode) RETURN n.kind AS kind, count(*) AS cnt
    `);
    const rows = await this.resultToRows(result);
    const stats: Record<string, number> = {};
    for (const r of rows) {
      stats[(r as any).kind || (r as any)['n.kind']] = Number((r as any).cnt || (r as any)['count(*)']);
    }
    return stats;
  }

  /** Run arbitrary Cypher */
  async runCypher(query: string, params: Record<string, any> = {}): Promise<any[]> {
    const result = await this._exec(query, params);
    return this.resultToRows(result);
  }

  async close(): Promise<void> {
    // kuzu's Connection.close() and Database.close() are both async —
    // we must await them to ensure the lock file is fully released before
    // another process/connection tries to open the same database.
    try { await this.conn?.close(); } catch {}
    try { await this.db?.close(); } catch {}
    GraphStore.pinned.delete(this);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Prepare a Cypher statement then execute it with parameters.
   *
   * kuzu's `Connection.execute()` requires a `PreparedStatement` (produced
   * by `Connection.prepare()`), not a raw query string. This helper bridges
   * the gap so callers can pass a string + params object.
   */
  private async _exec(
    query: string,
    params: Record<string, any> = {},
  ): Promise<kuzu.QueryResult> {
    const stmt = await this.conn.prepare(query);
    return this.conn.execute(stmt, params);
  }

  private async resultToRows(result: kuzu.QueryResult): Promise<Record<string, any>[]> {
    const rows: Record<string, any>[] = [];
    while (result.hasNext()) {
      const row = await result.getNext();
      rows.push(row as Record<string, any>);
    }
    return rows;
  }

  private rowToNode(row: Record<string, any>): BaseNode {
    const get = (key: string) => {
      if (row[key] !== undefined) return row[key];
      if (row[`n.${key}`] !== undefined) return row[`n.${key}`];
      if (row[`neighbor.${key}`] !== undefined) return row[`neighbor.${key}`];
      if (row[`dep.${key}`] !== undefined) return row[`dep.${key}`];
      for (const k of Object.keys(row)) {
        if (k.endsWith(`.${key}`)) return row[k];
      }
      return undefined;
    };

    return {
      id:            get('id')            ?? '',
      kind:          get('kind')          ?? 'Module',
      name:          get('name')          ?? (get('filePath') ? path.basename(get('filePath')) : ''),
      qualifiedName: get('qualifiedName') ?? '',
      filePath:      get('filePath')      ?? '',
      startLine:     Number(get('startLine') ?? 0),
      endLine:       Number(get('endLine')   ?? 0),
      fingerprint:   get('fingerprint')   ?? '',
      description:   get('description')   ?? '',
      metadata:      get('metadata')      ?? '{}',
    };
  }
}
