/**
 * Codebase Ontology Schema
 *
 * Defines the conceptual model: node types (entities) and edge types
 * (relationships) that represent a codebase as a knowledge graph.
 *
 * Design decisions:
 *  - Nodes are typed by their role in the code (Module, Class, Function, etc.)
 *  - Edges capture structural, dependency, and semantic relationships
 *  - Every node carries a fingerprint (content hash) for change detection
 *  - Architecture patterns are first-class nodes so they're queryable
 */

// ── Node (vertex) types ──────────────────────────────────────────────

export interface BaseNode {
  id: string;           // deterministic: kind + qualified name
  kind: NodeKind;
  name: string;
  qualifiedName: string; // e.g. src/auth/login.ts::AuthService.validate
  filePath: string;
  startLine: number;
  endLine: number;
  fingerprint: string;  // SHA-256 of the source text — drives change detection
  description: string;  // LLM-generated or heuristic summary
  metadata: string;     // JSON blob for kind-specific extras
}

export type NodeKind =
  | 'Module'           // a file
  | 'Class'
  | 'Interface'
  | 'Function'
  | 'Method'
  | 'Variable'
  | 'TypeAlias'
  | 'Enum'
  | 'Namespace'
  | 'Package'          // package.json / directory grouping
  | 'ArchPattern'      // detected architectural pattern
  | 'APIEndpoint'      // Express/Fastify route, REST endpoint
  | 'Config';          // configuration files (env, yaml, json)

// ── Edge (relationship) types ────────────────────────────────────────

export type EdgeKind =
  | 'IMPORTS'          // Module → Module
  | 'EXPORTS'          // Module → Function/Class/…
  | 'CONTAINS'         // Module/Class/Namespace → child
  | 'EXTENDS'          // Class → Class, Interface → Interface
  | 'IMPLEMENTS'       // Class → Interface
  | 'CALLS'            // Function/Method → Function/Method
  | 'INSTANTIATES'     // Function/Method → Class
  | 'USES_TYPE'        // Function/Method → Interface/TypeAlias
  | 'DEPENDS_ON'       // Package → Package (npm deps)
  | 'EXPOSES'          // Module → APIEndpoint
  | 'FOLLOWS_PATTERN'  // Module/Class → ArchPattern
  | 'READS_CONFIG'     // Module → Config
  | 'DECORATES';       // decorator → Class/Method

export interface Edge {
  fromId: string;
  toId: string;
  kind: EdgeKind;
  weight: number;      // 1.0 default; higher = tighter coupling
  metadata: string;
}

// ── Architecture pattern catalogue ───────────────────────────────────

export const ARCH_PATTERNS = [
  { id: 'pat:mvc',               name: 'MVC',                       signals: ['Controller', 'Model', 'View', 'Router'] },
  { id: 'pat:repository',        name: 'Repository Pattern',        signals: ['Repository', 'DataSource', 'Entity'] },
  { id: 'pat:factory',           name: 'Factory Pattern',           signals: ['Factory', 'create', 'build'] },
  { id: 'pat:singleton',         name: 'Singleton Pattern',         signals: ['getInstance', 'instance', 'private constructor'] },
  { id: 'pat:observer',          name: 'Observer / Event Emitter',  signals: ['EventEmitter', 'on(', 'emit(', 'subscribe'] },
  { id: 'pat:middleware',        name: 'Middleware Pipeline',        signals: ['middleware', 'use(', 'next('] },
  { id: 'pat:strategy',          name: 'Strategy Pattern',          signals: ['Strategy', 'Policy', 'Algorithm'] },
  { id: 'pat:decorator',         name: 'Decorator Pattern',         signals: ['@', 'Decorator', 'wrap'] },
  { id: 'pat:dependency-inject', name: 'Dependency Injection',      signals: ['inject', 'provide', '@Injectable', 'Container'] },
  { id: 'pat:cqrs',             name: 'CQRS',                      signals: ['Command', 'Query', 'Handler', 'Bus'] },
  { id: 'pat:layered',          name: 'Layered Architecture',       signals: ['controller', 'service', 'repository', 'model'] },
  { id: 'pat:hexagonal',        name: 'Hexagonal / Ports & Adapters', signals: ['Port', 'Adapter', 'UseCase', 'Domain'] },
] as const;

// ── KuzuDB DDL generators ────────────────────────────────────────────

export function getNodeTableDDL(): string {
  return `
    CREATE NODE TABLE IF NOT EXISTS CodeNode (
      id             STRING,
      kind           STRING,
      name           STRING,
      qualifiedName  STRING,
      filePath       STRING,
      startLine      INT64,
      endLine        INT64,
      fingerprint    STRING,
      description    STRING,
      metadata       STRING,
      PRIMARY KEY (id)
    );
  `;
}

export function getEdgeTableDDL(): string {
  return `
    CREATE REL TABLE IF NOT EXISTS CodeEdge (
      FROM CodeNode TO CodeNode,
      kind     STRING,
      weight   DOUBLE,
      metadata STRING
    );
  `;
}
