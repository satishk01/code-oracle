/**
 * Impact Analysis Engine
 *
 * Given a set of changed files (or specific symbols), computes the
 * blast radius: which other modules, classes, functions, endpoints,
 * and patterns are affected, scored by coupling weight.
 */

import { GraphStore } from '../graph/store.js';
import { BaseNode, Edge, NodeKind } from '../ontology/schema.js';

export interface ChangedItem {
  filePath: string;
  type: 'modified' | 'added' | 'deleted';
}

export interface ImpactNode {
  node: BaseNode;
  depth: number;        // hops from the change
  impactScore: number;  // 0-1 severity
  reason: string;       // human-readable explanation
}

export interface ImpactReport {
  changedFiles: string[];
  directImpacts: ImpactNode[];
  transitiveImpacts: ImpactNode[];
  affectedEndpoints: ImpactNode[];
  affectedPatterns: string[];
  riskScore: number;    // 0-100 overall risk
  summary: string;
}

export class ImpactAnalyzer {
  constructor(private store: GraphStore) {}

  async analyzeChanges(changes: ChangedItem[]): Promise<ImpactReport> {
    const directImpacts: ImpactNode[] = [];
    const transitiveImpacts: ImpactNode[] = [];
    const affectedEndpoints: ImpactNode[] = [];
    const affectedPatterns = new Set<string>();
    const visitedDirect = new Set<string>();
    const visitedTransitive = new Set<string>();
    const visitedEndpoints = new Set<string>();

    const [allNodes, allEdges, allPatterns] = await Promise.all([
      this.store.getAllNodes(),
      this.store.getAllEdges(),
      this.store.getNodesByKind('ArchPattern'),
    ]);

    const nodeMap = new Map<string, BaseNode>(allNodes.map(n => [n.id, n]));
    const resolvedFiles = new Set<string>();

    for (const change of changes) {
      const cleanPath = change.filePath.trim().replace(/\\/g, '/');
      if (!cleanPath) continue;

      // 1. Try exact match
      let nodesInFile = await this.store.getNodesByFile(change.filePath);

      // 2. If empty, try normalized slash match or suffix match across all nodes
      if (nodesInFile.length === 0) {
        nodesInFile = allNodes.filter(n => {
          if (!n.filePath) return false;
          const nNorm = n.filePath.replace(/\\/g, '/');
          return nNorm === cleanPath || nNorm.endsWith(`/${cleanPath}`) || nNorm.endsWith(`\\${cleanPath}`) || n.name.toLowerCase() === cleanPath.toLowerCase();
        });
      }

      // 3. If still empty, try substring search in node names
      if (nodesInFile.length === 0) {
        nodesInFile = allNodes.filter(n =>
          n.name.toLowerCase().includes(cleanPath.toLowerCase()) ||
          (n.qualifiedName && n.qualifiedName.toLowerCase().includes(cleanPath.toLowerCase()))
        ).slice(0, 15);
      }

      // 4. If still empty and cleanPath looks like a natural language prompt, extract keywords and find candidate files/nodes
      if (nodesInFile.length === 0) {
        const stopWords = new Set([
          'what', 'is', 'the', 'impact', 'if', 'i', 'need', 'to', 'add', 'two', 'more', 'and', 'or', 'a', 'an', 'in',
          'of', 'for', 'can', 'you', 'please', 'we', 'have', 'how', 'when', 'which', 'where', 'why', 'with', 'by',
          'related', 'with', 'drill', 'down', 'some', 'any', 'get', 'set',
        ]);
        const tokens = cleanPath
          .toLowerCase()
          .replace(/[^a-z0-9\s_-]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length >= 2 && !stopWords.has(t));

        if (tokens.length > 0) {
          nodesInFile = allNodes.filter(n => {
            const nameLow = n.name.toLowerCase();
            const pathLow = (n.filePath || '').toLowerCase();
            const qnLow = (n.qualifiedName || '').toLowerCase();
            const descLow = (n.description || '').toLowerCase();
            const text = `${nameLow} ${pathLow} ${qnLow} ${descLow}`;

            // Check if tokens match
            const matchCount = tokens.filter(tok => text.includes(tok)).length;
            if (matchCount > 0) return true;

            // If query mentions "endpoint" / "route" / "api", match APIEndpoints and servers
            if ((cleanPath.toLowerCase().includes('endpoint') || cleanPath.toLowerCase().includes('route') || cleanPath.toLowerCase().includes('api')) &&
                (n.kind === 'APIEndpoint' || pathLow.includes('server') || pathLow.includes('router') || pathLow.includes('api'))) {
              return true;
            }
            return false;
          }).slice(0, 25);
        }

        // 5. Ultimate fallback if still empty: grab main entry points & API server
        if (nodesInFile.length === 0) {
          nodesInFile = allNodes.filter(n => {
            const pathLow = (n.filePath || '').toLowerCase();
            return (pathLow.includes('server.ts') || pathLow.includes('app.ts') || pathLow.includes('index.ts') || n.kind === 'APIEndpoint');
          }).slice(0, 15);
        }
      }

      // Track resolved files
      for (const n of nodesInFile) {
        if (n.filePath && n.filePath !== '(unknown)') {
          resolvedFiles.add(n.filePath.replace(/\\/g, '/'));
        }
      }

      // Process all nodes in target files
      for (const node of nodesInFile) {
        // A. If node is an APIEndpoint
        if (node.kind === 'APIEndpoint') {
          if (!visitedEndpoints.has(node.id)) {
            visitedEndpoints.add(node.id);
            affectedEndpoints.push({
              node,
              depth: 0,
              impactScore: 1.0,
              reason: `Endpoint defined in ${node.filePath || change.filePath}`,
            });
          }
        } else if (node.kind !== 'Module') {
          // B. Target components in the file (Functions, Classes, Methods, Interfaces)
          if (!visitedDirect.has(node.id)) {
            visitedDirect.add(node.id);
            directImpacts.push({
              node,
              depth: 0,
              impactScore: 1.0,
              reason: `Target component in ${node.filePath || change.filePath}`,
            });
          }
        }

        // C. Inbound Callers & Dependents (who calls/imports this node)
        const inEdges = allEdges.filter(e => e.toId === node.id && ['CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'EXPOSES'].includes(e.kind));
        for (const e of inEdges) {
          const dep = nodeMap.get(e.fromId);
          if (!dep) continue;

          if (dep.kind === 'APIEndpoint') {
            if (!visitedEndpoints.has(dep.id)) {
              visitedEndpoints.add(dep.id);
              affectedEndpoints.push({
                node: dep,
                depth: 1,
                impactScore: this.calculateScore(e.kind, 1),
                reason: `${e.kind} → ${node.name} (${node.filePath})`,
              });
            }
          } else if (!visitedDirect.has(dep.id) && !visitedTransitive.has(dep.id)) {
            visitedDirect.add(dep.id);
            directImpacts.push({
              node: dep,
              depth: 1,
              impactScore: this.calculateScore(e.kind, 1),
              reason: `${e.kind} → ${node.name} (${node.filePath})`,
            });
          }
        }

        // D. Outbound Dependencies (what this node calls/imports/uses)
        const outEdges = allEdges.filter(e => e.fromId === node.id && ['CALLS', 'IMPORTS', 'USES_TYPE', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'EXPOSES'].includes(e.kind));
        for (const e of outEdges) {
          const target = nodeMap.get(e.toId);
          if (!target) continue;

          if (target.kind === 'APIEndpoint') {
            if (!visitedEndpoints.has(target.id)) {
              visitedEndpoints.add(target.id);
              affectedEndpoints.push({
                node: target,
                depth: 1,
                impactScore: this.calculateScore(e.kind, 1),
                reason: `Exposed/Called by ${node.name}`,
              });
            }
          } else if (!visitedDirect.has(target.id) && !visitedTransitive.has(target.id)) {
            visitedTransitive.add(target.id);
            transitiveImpacts.push({
              node: target,
              depth: 1,
              impactScore: this.calculateScore(e.kind, 1) * 0.8,
              reason: `Required/Used by ${node.name} (${e.kind} → ${target.name})`,
            });
          }
        }

        // E. Check patterns
        const followsEdges = allEdges.filter(e => e.fromId === node.id && e.kind === 'FOLLOWS_PATTERN');
        for (const fe of followsEdges) {
          const pat = allPatterns.find(p => p.id === fe.toId);
          if (pat) affectedPatterns.add(pat.name);
        }
      }
    }

    // Sort by impact score descending
    directImpacts.sort((a, b) => b.impactScore - a.impactScore);
    transitiveImpacts.sort((a, b) => b.impactScore - a.impactScore);
    affectedEndpoints.sort((a, b) => b.impactScore - a.impactScore);

    const riskScore = this.calculateOverallRisk(
      changes, directImpacts, transitiveImpacts, affectedEndpoints
    );

    const changedFilePaths = resolvedFiles.size > 0
      ? Array.from(resolvedFiles)
      : changes.map(c => c.filePath.replace(/\\/g, '/'));

    return {
      changedFiles: changedFilePaths,
      directImpacts,
      transitiveImpacts,
      affectedEndpoints,
      affectedPatterns: [...affectedPatterns],
      riskScore,
      summary: this.generateSummary(
        changes, directImpacts, transitiveImpacts,
        affectedEndpoints, affectedPatterns, riskScore
      ),
    };
  }

  /** Analyze impact of a single node by ID */
  async analyzeNode(nodeId: string): Promise<ImpactReport> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    return this.analyzeChanges([{
      filePath: node.filePath,
      type: 'modified',
    }]);
  }

  // ── Scoring ────────────────────────────────────────────────────

  private calculateScore(edgeKind: string, depth: number): number {
    const kindWeights: Record<string, number> = {
      EXTENDS: 0.95,
      IMPLEMENTS: 0.9,
      CALLS: 0.8,
      IMPORTS: 0.7,
      USES_TYPE: 0.7,
      INSTANTIATES: 0.75,
      CONTAINS: 0.5,
      EXPORTS: 0.6,
      EXPOSES: 0.85,
      FOLLOWS_PATTERN: 0.3,
      READS_CONFIG: 0.4,
    };
    const base = kindWeights[edgeKind] ?? 0.5;
    return Math.max(0.1, base * Math.pow(0.6, depth - 1));
  }

  private calculateOverallRisk(
    changes: ChangedItem[],
    direct: ImpactNode[],
    transitive: ImpactNode[],
    endpoints: ImpactNode[],
  ): number {
    let risk = 0;

    // Base risk from number of changed files
    risk += Math.min(20, changes.length * 5);

    // Direct impacts
    risk += Math.min(30, direct.length * 3);

    // Transitive impacts (lower weight)
    risk += Math.min(20, transitive.length * 1.5);

    // API endpoints affected (high risk)
    risk += Math.min(20, endpoints.length * 8);

    // Deleted files are riskier
    const deletions = changes.filter(c => c.type === 'deleted').length;
    risk += Math.min(10, deletions * 5);

    return Math.min(100, Math.round(risk));
  }

  private generateSummary(
    changes: ChangedItem[],
    direct: ImpactNode[],
    transitive: ImpactNode[],
    endpoints: ImpactNode[],
    patterns: Set<string>,
    risk: number,
  ): string {
    const lines: string[] = [];
    const riskLabel = risk < 25 ? 'Low' : risk < 50 ? 'Medium' : risk < 75 ? 'High' : 'Critical';

    lines.push(`## Impact Analysis — Risk: ${riskLabel} (${risk}/100)`);
    lines.push(`**${changes.length}** file(s) changed → **${direct.length}** direct + **${transitive.length}** transitive impacts`);

    if (endpoints.length > 0) {
      lines.push(`\n⚠ **${endpoints.length} API endpoint(s) affected:**`);
      for (const ep of endpoints.slice(0, 5)) {
        lines.push(`  - ${ep.node.name} (score: ${ep.impactScore.toFixed(2)})`);
      }
    }

    if (patterns.size > 0) {
      lines.push(`\nArchitectural patterns touched: ${[...patterns].join(', ')}`);
    }

    if (direct.length > 0) {
      lines.push(`\nTop direct impacts:`);
      for (const d of direct.slice(0, 8)) {
        lines.push(`  - ${d.node.kind}: ${d.node.qualifiedName} — ${d.reason}`);
      }
    }

    return lines.join('\n');
  }
}
