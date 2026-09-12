import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, ZoomIn, ZoomOut, RotateCcw, Maximize2, ChevronRight, ChevronDown,
  Layers, Box, Braces, FileCode, Cpu, Zap, Database, GitBranch,
  Folder, FolderOpen, X, Download, Copy, Check, Sparkles, ShieldAlert,
  ArrowRight, ExternalLink, Network, AlignLeft, Settings, FileText,
  Sliders, Compass, Eye, CornerDownRight, Hash
} from 'lucide-react';
import { GraphNode, GraphEdge, KIND_COLORS, KIND_ICONS } from './GraphExplorer';

export interface MindmapNode {
  id: string;
  name: string;
  kind: string;
  category: 'root' | 'category' | 'folder' | 'file' | 'class' | 'interface' | 'function' | 'endpoint' | 'pattern' | 'type' | 'config' | 'leaf';
  filePath?: string;
  startLine?: number;
  endLine?: number;
  description?: string;
  metadata?: string;
  children: MindmapNode[];
  rawNode?: GraphNode;
  totalEntities?: number;
  badge?: string;
}

interface LayoutNode {
  id: string;
  node: MindmapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  isMatched: boolean;
  parent?: LayoutNode;
  children: LayoutNode[];
  subtreeHeight: number;
}

interface MindmapTabProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  repoName: string;
  repoRoot: string;
  onSelectGraphNode: (node: GraphNode) => void;
  onNavigateToImpact: (filePath: string) => void;
  onNavigateToGraph: (nodeId: string) => void;
}

export function MindmapTab({
  nodes,
  edges,
  repoName,
  repoRoot,
  onSelectGraphNode,
  onNavigateToImpact,
  onNavigateToGraph,
}: MindmapTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 80, y: 320, scale: 0.85 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Search & Selection
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMindmapNode, setSelectedMindmapNode] = useState<MindmapNode | null>(null);
  const [copiedOutline, setCopiedOutline] = useState(false);

  // Set of expanded node IDs
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(['root']));

  // ── Build True Nested Hierarchical Tree ─────────────────────────────
  const rootTree = useMemo<MindmapNode>(() => {
    const rootDisplayName = repoName || repoRoot.split(/[\/\\]/).pop() || 'Repository';

    const root: MindmapNode = {
      id: 'root',
      name: rootDisplayName,
      kind: 'Package',
      category: 'root',
      children: [],
      totalEntities: nodes.length,
      badge: `${nodes.length} entities`,
    };

    if (nodes.length === 0) return root;

    // 1. Architecture Patterns Branch
    const patterns = nodes.filter(n => n.kind === 'ArchPattern');
    if (patterns.length > 0) {
      root.children.push({
        id: 'cat:patterns',
        name: 'Architecture Patterns',
        kind: 'ArchPattern',
        category: 'category',
        badge: `${patterns.length} patterns`,
        children: patterns.map(p => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          category: 'pattern',
          description: p.description,
          filePath: p.filePath,
          rawNode: p,
          children: [],
        })),
      });
    }

    // 2. API Endpoints Branch
    const endpoints = nodes.filter(n => n.kind === 'APIEndpoint');
    if (endpoints.length > 0) {
      root.children.push({
        id: 'cat:endpoints',
        name: 'API Endpoints & Routes',
        kind: 'APIEndpoint',
        category: 'category',
        badge: `${endpoints.length} routes`,
        children: endpoints.map(ep => {
          let method = 'API';
          let routePath = ep.name;
          try {
            const meta = JSON.parse(ep.metadata || '{}');
            if (meta.method) method = meta.method;
            if (meta.path) routePath = meta.path;
          } catch {}
          return {
            id: ep.id,
            name: `${method} ${routePath}`,
            kind: ep.kind,
            category: 'endpoint',
            description: ep.description,
            filePath: ep.filePath,
            startLine: ep.startLine,
            rawNode: ep,
            children: [],
          };
        }),
      });
    }

    // 3. Build Nested Directory / File / Entity Tree
    // Helper tree node for folders
    interface DirFolder {
      name: string;
      fullPath: string;
      subdirs: Map<string, DirFolder>;
      files: Map<string, GraphNode[]>;
    }

    const rootDirFolder: DirFolder = {
      name: 'root',
      fullPath: '',
      subdirs: new Map(),
      files: new Map(),
    };

    // Separate regular source nodes from patterns/endpoints
    const sourceNodes = nodes.filter(n => n.kind !== 'ArchPattern' && n.kind !== 'APIEndpoint');

    for (const node of sourceNodes) {
      const rawPath = (node.filePath || '').replace(/\\/g, '/');
      const parts = rawPath.split('/').filter(Boolean);

      if (parts.length <= 1) {
        // Root-level file (e.g. package.json, vite.config.ts)
        const fileName = parts[0] || 'root';
        if (!rootDirFolder.files.has(rawPath)) {
          rootDirFolder.files.set(rawPath, []);
        }
        rootDirFolder.files.get(rawPath)!.push(node);
      } else {
        // Nested path: traverse or create subdirectory nodes
        let currentFolder = rootDirFolder;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (!currentFolder.subdirs.has(seg)) {
            const fullPath = parts.slice(0, i + 1).join('/');
            currentFolder.subdirs.set(seg, {
              name: seg,
              fullPath,
              subdirs: new Map(),
              files: new Map(),
            });
          }
          currentFolder = currentFolder.subdirs.get(seg)!;
        }
        if (!currentFolder.files.has(rawPath)) {
          currentFolder.files.set(rawPath, []);
        }
        currentFolder.files.get(rawPath)!.push(node);
      }
    }

    // Helper: convert DirFolder recursively into MindmapNode
    function convertDirToMindmap(dir: DirFolder): MindmapNode[] {
      const result: MindmapNode[] = [];

      // Add subdirectories sorted alphabetically
      const sortedSubdirKeys = Array.from(dir.subdirs.keys()).sort();
      for (const key of sortedSubdirKeys) {
        const sub = dir.subdirs.get(key)!;
        const subChildren = convertDirToMindmap(sub);

        // Count total files in this folder tree
        let totalFilesCount = sub.files.size;
        function countFiles(d: DirFolder) {
          totalFilesCount += d.files.size;
          d.subdirs.forEach(countFiles);
        }
        sub.subdirs.forEach(countFiles);

        result.push({
          id: `dir:${sub.fullPath}`,
          name: sub.name,
          kind: 'Namespace',
          category: 'folder',
          filePath: sub.fullPath,
          badge: `${totalFilesCount} file${totalFilesCount === 1 ? '' : 's'}`,
          children: subChildren,
        });
      }

      // Add files in this folder sorted alphabetically
      const sortedFileKeys = Array.from(dir.files.keys()).sort();
      for (const filePath of sortedFileKeys) {
        const fileNodes = dir.files.get(filePath)!;
        const fileName = filePath.split('/').pop() || filePath;
        const moduleNode = fileNodes.find(n => n.kind === 'Module');

        const isConfigFile = fileName.includes('config') || fileName.endsWith('.json') || fileName.endsWith('.yaml') || fileName.endsWith('.yml');

        const fileMindmapNode: MindmapNode = {
          id: moduleNode ? moduleNode.id : `file:${filePath}`,
          name: fileName,
          kind: 'Module',
          category: isConfigFile ? 'config' : 'file',
          filePath: filePath,
          rawNode: moduleNode,
          description: moduleNode?.description,
          totalEntities: fileNodes.length,
          badge: fileNodes.length > 1 ? `${fileNodes.length} entities` : undefined,
          children: [],
        };

        // Extract Structures: Classes, Interfaces, Types, Enums
        const structures = fileNodes.filter(n => ['Class', 'Interface', 'Enum', 'TypeAlias'].includes(n.kind));
        const functionsAndOthers = fileNodes.filter(n => ['Function', 'Method', 'Variable', 'Config'].includes(n.kind));

        for (const struct of structures) {
          const structNode: MindmapNode = {
            id: struct.id,
            name: `${struct.kind === 'Class' ? 'class ' : struct.kind === 'Interface' ? 'interface ' : ''}${struct.name}`,
            kind: struct.kind,
            category: struct.kind === 'Class' ? 'class' : struct.kind === 'Interface' ? 'interface' : 'type',
            filePath: struct.filePath,
            startLine: struct.startLine,
            endLine: struct.endLine,
            description: struct.description,
            rawNode: struct,
            children: [],
          };

          // Find class methods
          const memberNodes = functionsAndOthers.filter(
            f => f.qualifiedName && f.qualifiedName.startsWith(`${struct.name}.`)
          );
          for (const member of memberNodes) {
            structNode.children.push({
              id: member.id,
              name: `${member.name}()`,
              kind: member.kind,
              category: 'function',
              filePath: member.filePath,
              startLine: member.startLine,
              endLine: member.endLine,
              description: member.description,
              rawNode: member,
              children: [],
            });
          }

          structNode.badge = structNode.children.length > 0 ? `${structNode.children.length} methods` : undefined;
          fileMindmapNode.children.push(structNode);
        }

        // Top-level standalone functions
        const standaloneFunctions = functionsAndOthers.filter(
          f => !structures.some(s => f.qualifiedName && f.qualifiedName.startsWith(`${s.name}.`))
        );

        for (const fn of standaloneFunctions) {
          fileMindmapNode.children.push({
            id: fn.id,
            name: `${fn.name}()`,
            kind: fn.kind,
            category: 'function',
            filePath: fn.filePath,
            startLine: fn.startLine,
            endLine: fn.endLine,
            description: fn.description,
            rawNode: fn,
            children: [],
          });
        }

        result.push(fileMindmapNode);
      }

      return result;
    }

    // Convert all root folders and files
    const dirNodes = convertDirToMindmap(rootDirFolder);
    for (const dn of dirNodes) {
      root.children.push(dn);
    }

    return root;
  }, [nodes, repoName, repoRoot]);

  // Initial Expand: Root + Top Folders + Top Files
  useEffect(() => {
    const initialExpanded = new Set<string>(['root']);
    for (const child of rootTree.children) {
      initialExpanded.add(child.id);
      for (const sub of child.children) {
        if (sub.category === 'folder' || sub.category === 'file') {
          initialExpanded.add(sub.id);
        }
      }
    }
    setExpandedIds(initialExpanded);
  }, [rootTree]);

  // Real-time Search Auto-expand
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const q = searchQuery.toLowerCase();
    const matchesToExpand = new Set<string>(expandedIds);

    function searchTree(n: MindmapNode, path: string[]): boolean {
      const isMatch = n.name.toLowerCase().includes(q) ||
                      (n.filePath && n.filePath.toLowerCase().includes(q)) ||
                      (n.description && n.description.toLowerCase().includes(q));

      let childMatch = false;
      for (const child of n.children) {
        if (searchTree(child, [...path, n.id])) {
          childMatch = true;
        }
      }

      if (isMatch || childMatch) {
        path.forEach(id => matchesToExpand.add(id));
        matchesToExpand.add(n.id);
        return true;
      }
      return false;
    }

    searchTree(rootTree, []);
    setExpandedIds(matchesToExpand);
  }, [searchQuery, rootTree]);

  // Toggle node expansion
  const toggleNode = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Depth Presets
  const setDepthLevel = useCallback((level: number) => {
    const next = new Set<string>(['root']);

    function traverse(node: MindmapNode, currentDepth: number) {
      if (currentDepth <= level) {
        next.add(node.id);
        for (const child of node.children) {
          traverse(child, currentDepth + 1);
        }
      }
    }

    traverse(rootTree, 1);
    setExpandedIds(next);
  }, [rootTree]);

  const expandAll = useCallback(() => {
    const next = new Set<string>();
    function traverse(n: MindmapNode) {
      next.add(n.id);
      n.children.forEach(traverse);
    }
    traverse(rootTree);
    setExpandedIds(next);
  }, [rootTree]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set(['root']));
  }, []);

  // ── Two-Pass Tidy Tree Layout Algorithm (NotebookLM Standard) ───────
  const layoutData = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const LEVEL_X_SPACING = 310;
    const NODE_HEIGHT = 46;
    const NODE_V_GAP = 14;

    // Pass 1: Measure node dimensions and calculate subtree heights
    interface TempLayoutNode {
      id: string;
      node: MindmapNode;
      width: number;
      height: number;
      depth: number;
      isExpanded: boolean;
      hasChildren: boolean;
      isMatched: boolean;
      children: TempLayoutNode[];
      subtreeHeight: number;
    }

    function measureTree(node: MindmapNode, depth: number): TempLayoutNode {
      const isExpanded = expandedIds.has(node.id);
      const isMatched = !!q && (
        node.name.toLowerCase().includes(q) ||
        (node.filePath || '').toLowerCase().includes(q) ||
        (node.description || '').toLowerCase().includes(q)
      );

      // Compute dynamic width with padding for badges and toggle button
      const charWidth = 8.2;
      const basePadding = 80;
      const calcWidth = Math.min(300, Math.max(170, node.name.length * charWidth + basePadding));

      const measuredChildren: TempLayoutNode[] = [];
      let subtreeHeight = NODE_HEIGHT;

      if (isExpanded && node.children.length > 0) {
        let childrenTotalHeight = 0;
        for (const child of node.children) {
          const childMeasured = measureTree(child, depth + 1);
          measuredChildren.push(childMeasured);
          childrenTotalHeight += childMeasured.subtreeHeight + NODE_V_GAP;
        }
        if (measuredChildren.length > 0) {
          childrenTotalHeight -= NODE_V_GAP; // remove last gap
        }
        subtreeHeight = Math.max(NODE_HEIGHT, childrenTotalHeight);
      }

      return {
        id: node.id,
        node,
        width: calcWidth,
        height: NODE_HEIGHT,
        depth,
        isExpanded,
        hasChildren: node.children.length > 0,
        isMatched,
        children: measuredChildren,
        subtreeHeight,
      };
    }

    const measuredRoot = measureTree(rootTree, 0);

    // Pass 2: Position nodes top-down with strict vertical boundaries
    const allLayoutNodes: LayoutNode[] = [];
    const allLayoutEdges: { source: LayoutNode; target: LayoutNode }[] = [];

    function positionTree(
      tempNode: TempLayoutNode,
      startX: number,
      startY: number,
      parent?: LayoutNode
    ): LayoutNode {
      const layoutNode: LayoutNode = {
        id: tempNode.id,
        node: tempNode.node,
        x: startX,
        y: startY + tempNode.subtreeHeight / 2 - tempNode.height / 2,
        width: tempNode.width,
        height: tempNode.height,
        depth: tempNode.depth,
        isExpanded: tempNode.isExpanded,
        hasChildren: tempNode.hasChildren,
        isMatched: tempNode.isMatched,
        parent,
        children: [],
        subtreeHeight: tempNode.subtreeHeight,
      };

      allLayoutNodes.push(layoutNode);
      if (parent) {
        allLayoutEdges.push({ source: parent, target: layoutNode });
      }

      if (tempNode.isExpanded && tempNode.children.length > 0) {
        let childCurrentY = startY;
        const nextX = startX + LEVEL_X_SPACING;

        for (const childTemp of tempNode.children) {
          const childLayout = positionTree(childTemp, nextX, childCurrentY, layoutNode);
          layoutNode.children.push(childLayout);
          childCurrentY += childTemp.subtreeHeight + NODE_V_GAP;
        }
      }

      return layoutNode;
    }

    const rootLayout = positionTree(measuredRoot, 40, 40);

    return { rootLayout, allLayoutNodes, allLayoutEdges, totalHeight: measuredRoot.subtreeHeight + 100 };
  }, [rootTree, expandedIds, searchQuery]);

  // Compute Active Highlight Path (Ancestors & Descendants of selected node)
  const highlightedPath = useMemo(() => {
    if (!selectedMindmapNode) return new Set<string>();
    const highlighted = new Set<string>([selectedMindmapNode.id]);

    // Add ancestors
    const nodeMap = new Map(layoutData.allLayoutNodes.map(ln => [ln.id, ln]));
    let curr = nodeMap.get(selectedMindmapNode.id);
    while (curr && curr.parent) {
      highlighted.add(curr.parent.id);
      curr = curr.parent;
    }

    // Add direct children
    const selLayout = nodeMap.get(selectedMindmapNode.id);
    if (selLayout) {
      selLayout.children.forEach(c => highlighted.add(c.id));
    }

    return highlighted;
  }, [selectedMindmapNode, layoutData]);

  // Fit to Screen
  const fitToScreen = useCallback(() => {
    if (layoutData.allLayoutNodes.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const ln of layoutData.allLayoutNodes) {
      if (ln.x < minX) minX = ln.x;
      if (ln.x + ln.width > maxX) maxX = ln.x + ln.width;
      if (ln.y < minY) minY = ln.y;
      if (ln.y + ln.height > maxY) maxY = ln.y + ln.height;
    }

    const treeWidth = maxX - minX + 140;
    const treeHeight = maxY - minY + 140;
    const cWidth = container.clientWidth || 1000;
    const cHeight = container.clientHeight || 700;

    const scaleX = cWidth / treeWidth;
    const scaleY = cHeight / treeHeight;
    const scale = Math.min(1.15, Math.max(0.3, Math.min(scaleX, scaleY) * 0.92));

    setTransform({
      x: 60 - minX * scale,
      y: (cHeight / 2) - ((minY + maxY) / 2) * scale,
      scale,
    });
  }, [layoutData]);

  // Pan / Drag Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('.mindmap-node-card')) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setTransform(prev => ({
      ...prev,
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    }));
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Wheel Zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.14 : 0.88;
    const newScale = Math.min(2.8, Math.max(0.2, transform.scale * zoomFactor));

    setTransform(prev => ({
      scale: newScale,
      x: mouseX - (mouseX - prev.x) * (newScale / prev.scale),
      y: mouseY - (mouseY - prev.y) * (newScale / prev.scale),
    }));
  };

  // Export Markdown Outline
  const exportOutline = useCallback(() => {
    let md = `# Codebase Mindmap: ${rootTree.name}\n\n`;

    function buildMd(node: MindmapNode, indent: number) {
      const prefix = '  '.repeat(indent) + '- ';
      const kindTag = node.kind ? ` \`[${node.kind}]\`` : '';
      const desc = node.description ? ` — *${node.description}*` : '';
      md += `${prefix}**${node.name}**${kindTag}${desc}\n`;
      for (const child of node.children) {
        buildMd(child, indent + 1);
      }
    }

    for (const child of rootTree.children) {
      buildMd(child, 0);
    }

    navigator.clipboard.writeText(md);
    setCopiedOutline(true);
    setTimeout(() => setCopiedOutline(false), 2500);
  }, [rootTree]);

  // Node Icon Helper
  const getNodeIcon = (node: MindmapNode) => {
    if (node.category === 'root') return Database;
    if (node.category === 'folder') return Folder;
    if (node.category === 'config') return Settings;
    if (node.category === 'file') return FileCode;
    if (node.category === 'class') return Box;
    if (node.category === 'interface') return Braces;
    if (node.category === 'pattern') return Layers;
    if (node.category === 'endpoint') return GitBranch;
    if (node.category === 'function') return Zap;
    return KIND_ICONS[node.kind] || FileCode;
  };

  return (
    <div className="mindmap-container">
      {/* Top Header / Toolbar */}
      <div className="mindmap-toolbar">
        <div className="mindmap-brand">
          <div className="mindmap-brand-badge">
            <Network size={18} className="mindmap-icon" />
          </div>
          <div className="mindmap-titles">
            <span className="mindmap-title">Codebase Mindmap</span>
            <span className="mindmap-subtitle">Hierarchical architecture & component ontology</span>
          </div>
        </div>

        {/* Search */}
        <div className="mindmap-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search classes, folders, functions…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear-btn" onClick={() => setSearchQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>

        {/* Level Presets */}
        <div className="mindmap-depth-presets">
          <span className="preset-label">Levels:</span>
          <button className="depth-pill" onClick={() => setDepthLevel(1)} title="Show Folders">
            1: Folders
          </button>
          <button className="depth-pill" onClick={() => setDepthLevel(2)} title="Show Files">
            2: Files
          </button>
          <button className="depth-pill" onClick={() => setDepthLevel(3)} title="Show Classes & Interfaces">
            3: Classes
          </button>
          <button className="depth-pill" onClick={() => setDepthLevel(4)} title="Show All Functions & Methods">
            4: All
          </button>
        </div>

        {/* Actions */}
        <div className="mindmap-quick-actions">
          <button className="action-pill-btn" onClick={expandAll} title="Expand All Branches">
            Expand All
          </button>
          <button className="action-pill-btn" onClick={collapseAll} title="Collapse All Branches">
            Collapse All
          </button>
          <button
            className={`action-pill-btn export-btn ${copiedOutline ? 'copied' : ''}`}
            onClick={exportOutline}
            title="Copy mindmap as Markdown outline"
          >
            {copiedOutline ? <Check size={13} /> : <Copy size={13} />}
            <span>{copiedOutline ? 'Copied MD!' : 'Copy Outline'}</span>
          </button>
        </div>
      </div>

      {/* Main Canvas Workspace */}
      <div className="mindmap-workspace">
        <div
          className="mindmap-canvas-area"
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: isDragging ? 'grabbing' : 'default' }}
        >
          {/* SVG Smooth Bezier Splines Layer */}
          <svg
            className="mindmap-svg-layer"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transformOrigin: '0 0',
            }}
          >
            <defs>
              <linearGradient id="edgeGradientDefault" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#4338ca" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0.55" />
              </linearGradient>
              <linearGradient id="edgeGradientActive" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#818cf8" />
              </linearGradient>
            </defs>

            {layoutData.allLayoutEdges.map(({ source, target }) => {
              // Exact anchor points on card boundaries
              const startX = source.x + source.width;
              const startY = source.y + source.height / 2;
              const endX = target.x;
              const endY = target.y + target.height / 2;

              // Smooth cubic bezier spline
              const dx = (endX - startX) * 0.55;
              const pathD = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;

              const isHighlighted = highlightedPath.has(source.id) && highlightedPath.has(target.id);
              const isMatched = target.isMatched;

              return (
                <path
                  key={`${source.id}->${target.id}`}
                  d={pathD}
                  fill="none"
                  stroke={isMatched ? '#f59e0b' : isHighlighted ? 'url(#edgeGradientActive)' : 'url(#edgeGradientDefault)'}
                  strokeWidth={isHighlighted || isMatched ? 2.5 : 1.5}
                  strokeOpacity={isHighlighted ? 0.95 : isMatched ? 0.9 : 0.5}
                  strokeLinecap="round"
                />
              );
            })}
          </svg>

          {/* HTML Overlay for Interactive Node Cards */}
          <div
            className="mindmap-cards-layer"
            style={{
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transformOrigin: '0 0',
            }}
          >
            {layoutData.allLayoutNodes.map(ln => {
              const { node } = ln;
              const Icon = getNodeIcon(node);
              const color = KIND_COLORS[node.kind] || '#6366f1';
              const isSelected = selectedMindmapNode?.id === node.id;
              const isPathActive = highlightedPath.has(node.id);
              const isRoot = node.category === 'root';
              const isFolder = node.category === 'folder';

              return (
                <div
                  key={ln.id}
                  className={`mindmap-node-card ${node.category} ${isSelected ? 'selected' : ''} ${isPathActive ? 'path-active' : ''} ${ln.isMatched ? 'search-match' : ''}`}
                  style={{
                    left: ln.x,
                    top: ln.y,
                    width: ln.width,
                    height: ln.height,
                    borderLeftColor: color,
                  }}
                  onClick={() => setSelectedMindmapNode(node)}
                >
                  {/* Left Icon Accent */}
                  <div className="card-icon-wrap" style={{ backgroundColor: `${color}20`, color }}>
                    <Icon size={15} />
                  </div>

                  {/* Body: Title and Badge */}
                  <div className="card-body">
                    <span className="card-title" title={node.name}>
                      {node.name}
                    </span>
                    {node.badge && (
                      <span className="card-sub-badge">{node.badge}</span>
                    )}
                  </div>

                  {/* Right Expand / Collapse Pill Button (NotebookLM style) */}
                  {ln.hasChildren && (
                    <button
                      className={`card-expand-btn ${ln.isExpanded ? 'expanded' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleNode(node.id);
                      }}
                      title={ln.isExpanded ? 'Collapse branch' : `Expand (${node.children.length} items)`}
                    >
                      {ln.isExpanded ? (
                        <span className="expand-symbol">−</span>
                      ) : (
                        <>
                          <span className="expand-symbol">+</span>
                          <span className="child-count-indicator">{node.children.length}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Floating Canvas Navigation Controls */}
          <div className="canvas-floating-controls">
            <button onClick={() => setTransform(p => ({ ...p, scale: Math.min(2.8, p.scale * 1.25) }))} title="Zoom In">
              <ZoomIn size={16} />
            </button>
            <button onClick={() => setTransform(p => ({ ...p, scale: Math.max(0.2, p.scale * 0.8) }))} title="Zoom Out">
              <ZoomOut size={16} />
            </button>
            <button onClick={() => setTransform({ x: 80, y: 320, scale: 0.85 })} title="Reset View (1:1)">
              <RotateCcw size={16} />
            </button>
            <button onClick={fitToScreen} title="Fit Mindmap to Screen">
              <Maximize2 size={16} />
            </button>
          </div>
        </div>

        {/* Selected Mindmap Node Inspector Drawer */}
        {selectedMindmapNode && (
          <aside className="mindmap-inspector-drawer">
            <div className="inspector-header">
              <div
                className="inspector-kind-badge"
                style={{
                  backgroundColor: `${KIND_COLORS[selectedMindmapNode.kind] || '#6366f1'}22`,
                  color: KIND_COLORS[selectedMindmapNode.kind] || '#6366f1',
                }}
              >
                {selectedMindmapNode.kind || selectedMindmapNode.category}
              </div>
              <button
                className="inspector-close-btn"
                onClick={() => setSelectedMindmapNode(null)}
                title="Close Inspector"
              >
                <X size={16} />
              </button>
            </div>

            <h3 className="inspector-title">{selectedMindmapNode.name}</h3>

            {selectedMindmapNode.filePath && (
              <div className="inspector-meta-row">
                <span className="meta-file">
                  {selectedMindmapNode.filePath}
                  {selectedMindmapNode.startLine ? `:${selectedMindmapNode.startLine}` : ''}
                </span>
                {selectedMindmapNode.endLine && selectedMindmapNode.startLine && selectedMindmapNode.endLine > selectedMindmapNode.startLine && (
                  <span className="meta-lines">({selectedMindmapNode.endLine - selectedMindmapNode.startLine + 1} lines)</span>
                )}
              </div>
            )}

            {/* Description / Summary */}
            {selectedMindmapNode.description && (
              <div className="inspector-section">
                <div className="section-label">
                  <Sparkles size={13} className="sparkle-icon" />
                  <span>Purpose & Code Description</span>
                </div>
                <p className="inspector-description">{selectedMindmapNode.description}</p>
              </div>
            )}

            {/* Sub-components / Children List */}
            {selectedMindmapNode.children.length > 0 && (
              <div className="inspector-section">
                <div className="section-label">
                  <span>Contains ({selectedMindmapNode.children.length})</span>
                </div>
                <div className="neighbor-cards-list">
                  {selectedMindmapNode.children.map(ch => (
                    <button
                      key={ch.id}
                      className="neighbor-card"
                      onClick={() => setSelectedMindmapNode(ch)}
                    >
                      <span
                        className="neighbor-kind-dot"
                        style={{ background: KIND_COLORS[ch.kind] || '#6366f1' }}
                      />
                      <div className="neighbor-info">
                        <span className="neighbor-name">{ch.name}</span>
                        <span className="neighbor-kind">{ch.kind || ch.category}</span>
                      </div>
                      <ChevronRight size={14} className="neighbor-arrow" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Actions */}
            <div className="inspector-actions">
              {selectedMindmapNode.rawNode && (
                <button
                  className="inspector-action-btn primary"
                  onClick={() => {
                    onSelectGraphNode(selectedMindmapNode.rawNode!);
                    onNavigateToGraph(selectedMindmapNode.rawNode!.id);
                  }}
                >
                  <Network size={14} />
                  <span>Open in Graph Explorer</span>
                </button>
              )}

              {selectedMindmapNode.filePath && (
                <button
                  className="inspector-action-btn"
                  onClick={() => onNavigateToImpact(selectedMindmapNode.filePath!)}
                >
                  <ShieldAlert size={14} />
                  <span>Analyze Impact</span>
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
