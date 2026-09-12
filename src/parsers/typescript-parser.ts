/**
 * TypeScript / JavaScript Parser
 *
 * Uses ts-morph to parse source files into ontology nodes & edges.
 * Handles: classes, interfaces, functions, methods, imports/exports,
 * type aliases, enums, decorators, and call-site analysis.
 */

import {
  Project, SourceFile, ClassDeclaration, FunctionDeclaration,
  InterfaceDeclaration, TypeAliasDeclaration, EnumDeclaration,
  MethodDeclaration, SyntaxKind, Node as TSNode,
  Symbol as TSSymbol, Expression, PropertyAccessExpression,
  Identifier,
} from 'ts-morph';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { BaseNode, Edge, NodeKind, EdgeKind, ARCH_PATTERNS } from '../ontology/schema.js';

export interface ParseResult {
  nodes: BaseNode[];
  edges: Edge[];
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function makeId(kind: NodeKind, qualifiedName: string): string {
  return `${kind.toLowerCase()}:${sha256(qualifiedName)}`;
}

export class TypeScriptParser {
  private project: Project;
  private tsconfigPaths: Record<string, string[]> | null = null;
  private tsconfigBaseUrl: string | null = null;
  private packageExports: Record<string, any> | null = null;

  constructor(tsconfigPath?: string) {
    this.project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: tsconfigPath ? undefined : {
        allowJs: true,
        target: 99, // ESNext
        module: 99,
        moduleResolution: 100,
        strict: false,
        skipLibCheck: true,
        noEmit: true,
      },
    });
  }

  /** Load tsconfig paths and package.json exports for import resolution. */
  loadPathConfig(repoRoot: string): void {
    // Load tsconfig.json paths/baseUrl
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    try {
      if (fs.existsSync(tsconfigPath)) {
        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
        const compilerOpts = tsconfig.compilerOptions ?? {};
        if (compilerOpts.paths) {
          this.tsconfigPaths = compilerOpts.paths;
        }
        if (compilerOpts.baseUrl) {
          this.tsconfigBaseUrl = path.resolve(repoRoot, compilerOpts.baseUrl);
        }
      }
    } catch {}

    // Load package.json exports
    const pkgPath = path.join(repoRoot, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        this.packageExports = pkg.exports ?? null;
      }
    } catch {}
  }

  parseFile(filePath: string, repoRoot: string): ParseResult {
    const relPath = path.relative(repoRoot, filePath);
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    const nodes: BaseNode[] = [];
    const edges: Edge[] = [];
    const fullText = sourceFile.getFullText();

    // ── Module node ───────────────────────────────────────────────
    const moduleId = makeId('Module', relPath);
    nodes.push({
      id: moduleId,
      kind: 'Module',
      name: path.basename(filePath),
      qualifiedName: relPath,
      filePath: relPath,
      startLine: 1,
      endLine: sourceFile.getEndLineNumber(),
      fingerprint: sha256(fullText),
      description: this.extractFileDescription(sourceFile),
      metadata: JSON.stringify({
        lineCount: sourceFile.getEndLineNumber(),
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'TypeScript' : 'JavaScript',
      }),
    });

    // ── Imports ────────────────────────────────────────────────────
    for (const imp of sourceFile.getImportDeclarations()) {
      const modSpecifier = imp.getModuleSpecifierValue();
      if (modSpecifier.startsWith('.')) {
        const resolved = this.resolveImport(filePath, modSpecifier, repoRoot);
        if (resolved) {
          const targetModuleId = makeId('Module', resolved);
          edges.push({
            fromId: moduleId,
            toId: targetModuleId,
            kind: 'IMPORTS',
            weight: 1.0,
            metadata: JSON.stringify({
              namedImports: imp.getNamedImports().map(n => n.getName()),
              defaultImport: imp.getDefaultImport()?.getText() ?? null,
            }),
          });
        }
      }
    }

    // ── Classes ────────────────────────────────────────────────────
    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName() ?? 'AnonymousClass';
      const qn = `${relPath}::${className}`;
      const classId = makeId('Class', qn);

      nodes.push({
        id: classId,
        kind: 'Class',
        name: className,
        qualifiedName: qn,
        filePath: relPath,
        startLine: cls.getStartLineNumber(),
        endLine: cls.getEndLineNumber(),
        fingerprint: sha256(cls.getFullText()),
        description: this.extractJsDoc(cls) || `Class ${className}`,
        metadata: JSON.stringify({
          isAbstract: cls.isAbstract(),
          isExported: cls.isExported(),
          decorators: cls.getDecorators().map(d => d.getName()),
          propertyCount: cls.getProperties().length,
          methodCount: cls.getMethods().length,
        }),
      });

      edges.push({ fromId: moduleId, toId: classId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
      if (cls.isExported()) {
        edges.push({ fromId: moduleId, toId: classId, kind: 'EXPORTS', weight: 1.0, metadata: '{}' });
      }

      // Extends — Phase 4: try symbol resolution
      const baseClass = cls.getExtends();
      if (baseClass) {
        const baseName = baseClass.getText();
        const baseId = this.resolveSymbolId(baseClass.getExpression(), 'Class', baseName);
        edges.push({ fromId: classId, toId: baseId, kind: 'EXTENDS', weight: 1.5, metadata: JSON.stringify({ resolved: baseId !== makeId('Class', `*::${baseName}`) }) });
      }

      // Implements — Phase 4: try symbol resolution
      for (const impl of cls.getImplements()) {
        const ifaceName = impl.getText();
        const ifaceId = this.resolveSymbolId(impl.getExpression(), 'Interface', ifaceName);
        edges.push({ fromId: classId, toId: ifaceId, kind: 'IMPLEMENTS', weight: 1.5, metadata: JSON.stringify({ resolved: ifaceId !== makeId('Interface', `*::${ifaceName}`) }) });
      }

      // Methods
      for (const method of cls.getMethods()) {
        const methodName = method.getName();
        const mqn = `${qn}.${methodName}`;
        const methodId = makeId('Method', mqn);

        nodes.push({
          id: methodId,
          kind: 'Method',
          name: methodName,
          qualifiedName: mqn,
          filePath: relPath,
          startLine: method.getStartLineNumber(),
          endLine: method.getEndLineNumber(),
          fingerprint: sha256(method.getFullText()),
          description: this.extractJsDoc(method) || `Method ${className}.${methodName}`,
          metadata: JSON.stringify({
            isAsync: method.isAsync(),
            isStatic: method.isStatic(),
            visibility: method.getScope(),
            paramCount: method.getParameters().length,
            returnType: method.getReturnType().getText().slice(0, 120),
          }),
        });

        edges.push({ fromId: classId, toId: methodId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
        this.extractCalls(method, mqn, methodId, edges);
      }
    }

    // ── Interfaces ────────────────────────────────────────────────
    for (const iface of sourceFile.getInterfaces()) {
      const ifaceName = iface.getName();
      const qn = `${relPath}::${ifaceName}`;
      const ifaceId = makeId('Interface', qn);

      nodes.push({
        id: ifaceId,
        kind: 'Interface',
        name: ifaceName,
        qualifiedName: qn,
        filePath: relPath,
        startLine: iface.getStartLineNumber(),
        endLine: iface.getEndLineNumber(),
        fingerprint: sha256(iface.getFullText()),
        description: this.extractJsDoc(iface) || `Interface ${ifaceName}`,
        metadata: JSON.stringify({
          isExported: iface.isExported(),
          propertyCount: iface.getProperties().length,
          methodCount: iface.getMethods().length,
        }),
      });

      edges.push({ fromId: moduleId, toId: ifaceId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
      if (iface.isExported()) {
        edges.push({ fromId: moduleId, toId: ifaceId, kind: 'EXPORTS', weight: 1.0, metadata: '{}' });
      }

      for (const ext of iface.getExtends()) {
        const baseName = ext.getText();
        const baseId = this.resolveSymbolId(ext.getExpression(), 'Interface', baseName);
        edges.push({ fromId: ifaceId, toId: baseId, kind: 'EXTENDS', weight: 1.5, metadata: JSON.stringify({ resolved: baseId !== makeId('Interface', `*::${baseName}`) }) });
      }
    }

    // ── Standalone functions ──────────────────────────────────────
    for (const fn of sourceFile.getFunctions()) {
      const fnName = fn.getName() ?? 'anonymous';
      const qn = `${relPath}::${fnName}`;
      const fnId = makeId('Function', qn);

      nodes.push({
        id: fnId,
        kind: 'Function',
        name: fnName,
        qualifiedName: qn,
        filePath: relPath,
        startLine: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        fingerprint: sha256(fn.getFullText()),
        description: this.extractJsDoc(fn) || `Function ${fnName}`,
        metadata: JSON.stringify({
          isAsync: fn.isAsync(),
          isExported: fn.isExported(),
          isGenerator: fn.isGenerator(),
          paramCount: fn.getParameters().length,
        }),
      });

      edges.push({ fromId: moduleId, toId: fnId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
      if (fn.isExported()) {
        edges.push({ fromId: moduleId, toId: fnId, kind: 'EXPORTS', weight: 1.0, metadata: '{}' });
      }
      this.extractCalls(fn, qn, fnId, edges);
    }

    // ── Type aliases ──────────────────────────────────────────────
    for (const ta of sourceFile.getTypeAliases()) {
      const taName = ta.getName();
      const qn = `${relPath}::${taName}`;
      const taId = makeId('TypeAlias', qn);

      nodes.push({
        id: taId,
        kind: 'TypeAlias',
        name: taName,
        qualifiedName: qn,
        filePath: relPath,
        startLine: ta.getStartLineNumber(),
        endLine: ta.getEndLineNumber(),
        fingerprint: sha256(ta.getFullText()),
        description: `Type alias ${taName}`,
        metadata: JSON.stringify({ isExported: ta.isExported() }),
      });

      edges.push({ fromId: moduleId, toId: taId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
    }

    // ── Enums ─────────────────────────────────────────────────────
    for (const en of sourceFile.getEnums()) {
      const enName = en.getName();
      const qn = `${relPath}::${enName}`;
      const enId = makeId('Enum', qn);

      nodes.push({
        id: enId,
        kind: 'Enum',
        name: enName,
        qualifiedName: qn,
        filePath: relPath,
        startLine: en.getStartLineNumber(),
        endLine: en.getEndLineNumber(),
        fingerprint: sha256(en.getFullText()),
        description: `Enum ${enName} with ${en.getMembers().length} members`,
        metadata: JSON.stringify({
          members: en.getMembers().map(m => m.getName()),
          isExported: en.isExported(),
        }),
      });

      edges.push({ fromId: moduleId, toId: enId, kind: 'CONTAINS', weight: 1.0, metadata: '{}' });
    }

    // ── Architecture patterns ─────────────────────────────────────
    this.detectPatterns(fullText, className => {
      return nodes.find(n => n.name === className)?.id;
    }, moduleId, nodes, edges);

    // ── API endpoints (Express-style) ─────────────────────────────
    this.detectAPIEndpoints(sourceFile, relPath, moduleId, nodes, edges);

    // Clean up
    this.project.removeSourceFile(sourceFile);

    return { nodes, edges };
  }

  // ── Internal helpers ───────────────────────────────────────────

  /**
   * Extract CALLS edges using ts-morph's type checker for symbol resolution.
   *
   * Phase 4 improvement: Instead of creating edges to `*::${calleeName}` (which
   * causes cross-file name collisions), we use `getSymbol()` on the call
   * expression to resolve to the actual declaration. This produces edges that
   * point to real symbol targets.
   *
   * Falls back to name-based matching if the type checker can't resolve the
   * symbol (e.g. for dynamic calls or external library functions).
   */
  private extractCalls(
    fn: FunctionDeclaration | MethodDeclaration,
    qualifiedName: string,
    fnId: string,
    edges: Edge[],
  ): void {
    const callExprs = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    const seen = new Set<string>();

    for (const call of callExprs) {
      const expr = call.getExpression();
      const callText = expr.getText();
      if (seen.has(callText)) continue;
      seen.add(callText);

      let calleeId: string | null = null;
      let resolved = false;

      // Phase 4: Try symbol resolution via the type checker
      try {
        const symbol = expr.getSymbol();
        if (symbol) {
          const declarations = symbol.getDeclarations();
          if (declarations.length > 0) {
            const decl = declarations[0];
            const declKind = this.getDeclNodeKind(decl);
            if (declKind) {
              // Build the qualified name from the declaration's source file + name
              const sourceFile = decl.getSourceFile();
              if (sourceFile) {
                const declRelPath = sourceFile.getFilePath();
                const declName = this.getDeclName(decl) ?? callText;
                const declQn = `${declRelPath}::${declName}`;
                calleeId = makeId(declKind, declQn);
                resolved = true;
              }
            }
          }
        }
      } catch {}

      // Fallback: name-based matching (preserves backward compatibility)
      if (!calleeId) {
        const parts = callText.split('.');
        const calleeName = parts[parts.length - 1];
        calleeId = makeId('Function', `*::${calleeName}`);
      }

      edges.push({
        fromId: fnId,
        toId: calleeId,
        kind: 'CALLS',
        weight: 1.0,
        metadata: JSON.stringify({
          callExpression: callText.slice(0, 100),
          resolved,
        }),
      });
    }
  }

  /**
   * Resolve an expression to a symbol-based node ID using the type checker.
   * Falls back to name-based `*::${name}` matching if resolution fails.
   */
  private resolveSymbolId(expr: Expression, kind: NodeKind, fallbackName: string): string {
    try {
      const symbol = expr.getSymbol();
      if (symbol) {
        const declarations = symbol.getDeclarations();
        if (declarations.length > 0) {
          const decl = declarations[0];
          const declKind = this.getDeclNodeKind(decl) ?? kind;
          const sourceFile = decl.getSourceFile();
          if (sourceFile) {
            const declName = this.getDeclName(decl) ?? fallbackName;
            const declQn = `${sourceFile.getFilePath()}::${declName}`;
            return makeId(declKind, declQn);
          }
        }
      }
    } catch {}
    return makeId(kind, `*::${fallbackName}`);
  }

  /** Determine the NodeKind for a ts-morph declaration node. */
  private getDeclNodeKind(decl: TSNode): NodeKind | null {
    const kind = decl.getKind();
    switch (kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
        return 'Function';
      case SyntaxKind.MethodDeclaration:
        return 'Method';
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return 'Class';
      case SyntaxKind.InterfaceDeclaration:
        return 'Interface';
      case SyntaxKind.TypeAliasDeclaration:
        return 'TypeAlias';
      case SyntaxKind.EnumDeclaration:
        return 'Enum';
      default:
        return null;
    }
  }

  /** Extract the name from a declaration node. */
  private getDeclName(decl: TSNode): string | null {
    if ('getName' in decl && typeof (decl as any).getName === 'function') {
      try {
        return (decl as any).getName() ?? null;
      } catch {}
    }
    return null;
  }

  private detectPatterns(
    sourceText: string,
    findNodeId: (name: string) => string | undefined,
    moduleId: string,
    nodes: BaseNode[],
    edges: Edge[],
  ): void {
    for (const pattern of ARCH_PATTERNS) {
      const matchCount = pattern.signals.filter(sig =>
        sourceText.includes(sig)
      ).length;

      if (matchCount >= 2 || (matchCount === 1 && pattern.signals.length <= 2)) {
        // Add or reference the pattern node
        const patternNode: BaseNode = {
          id: pattern.id,
          kind: 'ArchPattern',
          name: pattern.name,
          qualifiedName: pattern.id,
          filePath: '',
          startLine: 0,
          endLine: 0,
          fingerprint: sha256(pattern.name),
          description: `Architectural pattern: ${pattern.name}`,
          metadata: JSON.stringify({ signals: pattern.signals }),
        };
        nodes.push(patternNode);

        edges.push({
          fromId: moduleId,
          toId: pattern.id,
          kind: 'FOLLOWS_PATTERN',
          weight: matchCount / pattern.signals.length,
          metadata: JSON.stringify({
            matchedSignals: pattern.signals.filter(s => sourceText.includes(s)),
          }),
        });
      }
    }
  }

  /**
   * Detect API endpoints in the source file.
   *
   * Phase 4 improvement: Now supports:
   *  - Express: `app.get('/path', ...)`, `router.post('/path', ...)`
   *  - Fastify: `fastify.get('/path', ...)`, `server.route({ method, url })`
   *  - Parameterized routes: `/users/:id`, `/api/v1/:resource/:id`
   *  - Decorator-based: `@Get('/path')`, `@Post('/path')` (NestJS-style)
   *  - Next.js API routes: files in `pages/api/` or `app/api/`
   */
  private detectAPIEndpoints(
    sourceFile: SourceFile,
    relPath: string,
    moduleId: string,
    nodes: BaseNode[],
    edges: Edge[],
  ): void {
    const text = sourceFile.getFullText();
    const lineOffset = (idx: number) => text.slice(0, idx).split('\n').length;

    // 1. Express/Fastify method calls: `.get('/path', ...)`, `.post('/path', ...)`
    const routeRegex = /\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(text)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      this.addEndpointNode(nodes, edges, relPath, moduleId, method, routePath, lineOffset(match.index));
    }

    // 2. Fastify route options: `fastify.route({ method: 'GET', url: '/path' })`
    const fastifyRouteRegex = /route\s*\(\s*\{[^}]*method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`][^}]*url\s*:\s*['"`]([^'"`]+)['"`]/gi;
    while ((match = fastifyRouteRegex.exec(text)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      this.addEndpointNode(nodes, edges, relPath, moduleId, method, routePath, lineOffset(match.index));
    }

    // 3. Decorator-based: `@Get('/path')`, `@Post('/path')`
    const decoratorRegex = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    while ((match = decoratorRegex.exec(text)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      this.addEndpointNode(nodes, edges, relPath, moduleId, method, routePath, lineOffset(match.index));
    }

    // 4. Next.js API routes: files in pages/api/ or app/api/ directories
    if (relPath.includes('/pages/api/') || relPath.includes('/app/api/') || relPath.includes('\\pages\\api\\') || relPath.includes('\\app\\api\\')) {
      // The route path is derived from the file path
      const apiDirIdx = relPath.search(/[/\\](pages|app)[/\\]api[/\\]/);
      if (apiDirIdx >= 0) {
        const afterApi = relPath.slice(apiDirIdx + 6); // skip `/pages/api` or `/app/api`
        const routePath = '/' + afterApi
          .replace(/\.(ts|tsx|js|jsx)$/, '')
          .replace(/[/\\]index$/, '')
          .replace(/\[/g, ':').replace(/\]/g, ''); // [id] → :id
      this.addEndpointNode(nodes, edges, relPath, moduleId, 'ALL', routePath, 1);
      }
    }
  }

  /** Add an API endpoint node + EXPOSES edge. */
  private addEndpointNode(
    nodes: BaseNode[],
    edges: Edge[],
    relPath: string,
    moduleId: string,
    method: string,
    routePath: string,
    line: number,
  ): void {
    const qn = `${relPath}::${method} ${routePath}`;
    const endpointId = makeId('APIEndpoint', qn);

    // Avoid duplicates
    if (nodes.some(n => n.id === endpointId)) return;

    nodes.push({
      id: endpointId,
      kind: 'APIEndpoint',
      name: `${method} ${routePath}`,
      qualifiedName: qn,
      filePath: relPath,
      startLine: line,
      endLine: line,
      fingerprint: sha256(qn),
      description: `API endpoint: ${method} ${routePath}`,
      metadata: JSON.stringify({ method, path: routePath }),
    });

    edges.push({ fromId: moduleId, toId: endpointId, kind: 'EXPOSES', weight: 1.5, metadata: '{}' });
  }

  private extractJsDoc(node: { getJsDocs?: () => any[] }): string {
    try {
      const docs = node.getJsDocs?.();
      if (docs && docs.length > 0) {
        return docs[0].getDescription?.()?.trim() ?? '';
      }
    } catch {}
    return '';
  }

  private extractFileDescription(sf: SourceFile): string {
    // Use first JSDoc comment or first line comment
    const leadingComments = sf.getLeadingCommentRanges();
    if (leadingComments.length > 0) {
      const text = leadingComments[0].getText();
      return text.replace(/^\/\*\*?\s*|\s*\*\/$/g, '').replace(/^\s*\*\s?/gm, '').trim().slice(0, 200);
    }
    return `Module: ${path.basename(sf.getFilePath())}`;
  }

  /**
   * Resolve an import specifier to a relative file path.
   *
   * Phase 4 improvement: Now consults:
   *  1. tsconfig.json `paths` / `baseUrl` for path aliases (e.g. `@/components/*`)
   *  2. package.json `exports` / `main` / `module` fields for self-referencing
   *  3. Relative path resolution with file extensions (original behavior)
   *  4. node_modules aliases (basic)
   *
   * Returns the path relative to repoRoot, or null if it can't be resolved.
   */
  private resolveImport(fromFile: string, specifier: string, repoRoot: string): string | null {
    const dir = path.dirname(fromFile);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];

    // 1. Try tsconfig paths mapping
    if (this.tsconfigPaths) {
      for (const [pattern, replacements] of Object.entries(this.tsconfigPaths)) {
        // Convert tsconfig path pattern to regex: `@/components/*` → `@/components/(.+)`
        const regexPattern = pattern.replace(/\*/, '(.+)');
        const match = new RegExp(`^${regexPattern}$`).exec(specifier);
        if (match) {
          for (const replacement of replacements) {
            const resolvedSpec = replacement.replace(/\*/, match[1] ?? '');
            const basePath = this.tsconfigBaseUrl
              ? path.resolve(this.tsconfigBaseUrl, resolvedSpec)
              : path.resolve(repoRoot, resolvedSpec);
            const rel = this.tryFileExtensions(basePath, extensions, repoRoot);
            if (rel) return rel;
          }
        }
      }
    }

    // 2. Try package.json exports (self-referencing)
    if (this.packageExports && !specifier.startsWith('.')) {
      const pkgName = Object.keys(this.packageExports).find(k => specifier === k || specifier.startsWith(k + '/'));
      if (pkgName) {
        const subpath = specifier === pkgName ? '.' : specifier.slice(pkgName.length);
        const exportEntry = this.packageExports[pkgName];
        const exportPath = typeof exportEntry === 'string'
          ? exportEntry
          : exportEntry?.import ?? exportEntry?.default ?? exportEntry?.['.'];
        if (exportPath) {
          const basePath = path.resolve(repoRoot, exportPath);
          const rel = this.tryFileExtensions(basePath, extensions, repoRoot);
          if (rel) return rel;
        }
      }
    }

    // 3. Relative path resolution (original behavior, enhanced)
    if (specifier.startsWith('.')) {
      const basePath = path.resolve(dir, specifier);
      const rel = this.tryFileExtensions(basePath, extensions, repoRoot);
      if (rel) return rel;
    }

    // 4. node_modules resolution (basic — for internal packages)
    if (!specifier.startsWith('.')) {
      const nodeModulesPath = path.resolve(repoRoot, 'node_modules', specifier);
      const rel = this.tryFileExtensions(nodeModulesPath, extensions, repoRoot);
      if (rel && !rel.startsWith('..')) return rel;
    }

    // Fallback: return the specifier as-is relative to repo root
    return path.relative(repoRoot, path.resolve(dir, specifier));
  }

  /** Try a base path with various extensions, return relative path if file exists. */
  private tryFileExtensions(basePath: string, extensions: string[], repoRoot: string): string | null {
    // Try the path directly (it might already have an extension)
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      const rel = path.relative(repoRoot, basePath);
      if (!rel.startsWith('..')) return rel;
    }
    // Try each extension
    for (const ext of extensions) {
      const candidate = basePath + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const rel = path.relative(repoRoot, candidate);
        if (!rel.startsWith('..')) return rel;
      }
    }
    return null;
  }
}
