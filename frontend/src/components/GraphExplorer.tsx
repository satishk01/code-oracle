import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, ZoomIn, ZoomOut, RotateCcw, Maximize2, ChevronRight, ChevronDown,
  Layers, Box, Braces, FileCode, Cpu, Zap, Database, GitBranch,
  Eye, Filter, Folder, X, ArrowRight, ShieldAlert, Sparkles
} from 'lucide-react';

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  description: string;
  metadata: string;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
}

export const KIND_COLORS: Record<string, string> = {
  Module: '#6366f1',
  Class: '#f59e0b',
  Interface: '#10b981',
  Function: '#3b82f6',
  Method: '#8b5cf6',
  TypeAlias: '#ec4899',
  Enum: '#f97316',
  Package: '#14b8a6',
  ArchPattern: '#ef4444',
  APIEndpoint: '#06b6d4',
  Config: '#78716c',
  Namespace: '#a855f7',
  Variable: '#64748b',
};

export const KIND_ICONS: Record<string, any> = {
  Module: FileCode,
  Class: Box,
  Interface: Braces,
  Function: Zap,
  Method: Cpu,
  Package: Database,
  ArchPattern: Layers,
  APIEndpoint: GitBranch,
};

type ViewMode = 'modules' | 'focus' | 'all';

interface GraphExplorerProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  allNodes: GraphNode[];
  selectedNode: GraphNode | null;
  neighborhood: any;
  onSelectNode: (node: GraphNode) => void;
  onCloseNode: () => void;
  searchQuery: string;
  searchResults: GraphNode[];
  onSearch: (q: string) => void;
  kindFilter: string;
  onKindFilter: (kind: string) => void;
  onNavigateToImpact?: (filePath: string) => void;
  onNavigateToMindmap?: (nodeId: string) => void;
}

interface NodePosition {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isModule?: boolean;
  parentModuleId?: string;
  childCount?: number;
}

export function GraphExplorer({
  nodes,
  edges,
  allNodes,
  selectedNode,
  neighborhood,
  onSelectNode,
  onCloseNode,
  searchQuery,
  searchResults,
  onSearch,
  kindFilter,
  onKindFilter,
  onNavigateToImpact,
  onNavigateToMindmap,
}: GraphExplorerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('modules');
  const [focusDepth, setFocusDepth] = useState<number>(1);
  const [selectedDirectory, setSelectedDirectory] = useState<string>('all');
  
  // Set of module IDs that are currently expanded to show inner details
  const [expandedModuleIds, setExpandedModuleIds] = useState<Set<string>>(new Set());

  // Transform state for pan / zoom
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);

  // Node positions map for physics/rendering
  const positionsRef = useRef<Map<string, NodePosition>>(new Map());
  const [animTrigger, setAnimTrigger] = useState(0);

  // Group nodes by file/module
  const { moduleMap, fileEntitiesMap, directoryList, moduleNodeMap } = useMemo(() => {
    const fileEntities = new Map<string, GraphNode[]>();
    const modNodeMap = new Map<string, GraphNode>();
    const dirs = new Set<string>();

    for (const node of allNodes) {
      if (!node.filePath) continue;
      const normPath = node.filePath.replace(/\\/g, '/');
      const dir = normPath.includes('/') ? normPath.substring(0, normPath.lastIndexOf('/')) : '.';
      dirs.add(dir);

      if (!fileEntities.has(normPath)) {
        fileEntities.set(normPath, []);
      }
      fileEntities.get(normPath)!.push(node);

      if (node.kind === 'Module') {
        modNodeMap.set(normPath, node);
      }
    }

    return {
      moduleMap: fileEntities,
      fileEntitiesMap: fileEntities,
      directoryList: Array.from(dirs).sort(),
      moduleNodeMap: modNodeMap,
    };
  }, [allNodes]);

  // Compute active visible nodes and edges based on viewMode & expandedModules
  const { visibleNodes, visibleEdges, aggregatedEdges } = useMemo(() => {
    // 1. Focused Subgraph Mode
    if (viewMode === 'focus' && selectedNode) {
      const neighborIdSet = new Set<string>([selectedNode.id]);
      
      // Add direct neighbors
      for (const e of edges) {
        if (e.fromId === selectedNode.id) neighborIdSet.add(e.toId);
        if (e.toId === selectedNode.id) neighborIdSet.add(e.fromId);
      }

      // Add 2-hop if focusDepth >= 2
      if (focusDepth >= 2) {
        const hop1 = Array.from(neighborIdSet);
        for (const id of hop1) {
          for (const e of edges) {
            if (e.fromId === id) neighborIdSet.add(e.toId);
            if (e.toId === id) neighborIdSet.add(e.fromId);
          }
        }
      }

      // Add 3-hop if focusDepth >= 3
      if (focusDepth >= 3) {
        const hop2 = Array.from(neighborIdSet);
        for (const id of hop2) {
          for (const e of edges) {
            if (e.fromId === id) neighborIdSet.add(e.toId);
            if (e.toId === id) neighborIdSet.add(e.fromId);
          }
        }
      }

      const nodeMap = new Map(allNodes.map(n => [n.id, n]));
      const vNodes: GraphNode[] = [];
      for (const id of neighborIdSet) {
        const n = nodeMap.get(id);
        if (n) vNodes.push(n);
      }

      const vEdges = edges.filter(e => neighborIdSet.has(e.fromId) && neighborIdSet.has(e.toId));
      return { visibleNodes: vNodes, visibleEdges: vEdges, aggregatedEdges: [] };
    }

    // 2. All Entities Mode
    if (viewMode === 'all') {
      let vNodes = nodes;
      if (selectedDirectory !== 'all') {
        vNodes = vNodes.filter(n => {
          const norm = (n.filePath || '').replace(/\\/g, '/');
          return norm.startsWith(selectedDirectory);
        });
      }
      const vNodeIds = new Set(vNodes.map(n => n.id));
      const vEdges = edges.filter(e => vNodeIds.has(e.fromId) && vNodeIds.has(e.toId));
      return { visibleNodes: vNodes, visibleEdges: vEdges, aggregatedEdges: [] };
    }

    // 3. Modules View (Hierarchical / Expandable) — DEFAULT
    // Base nodes: All Modules + Architecture Patterns
    const baseNodes: GraphNode[] = [];
    const baseNodeIds = new Set<string>();

    for (const node of allNodes) {
      const norm = (node.filePath || '').replace(/\\/g, '/');
      if (selectedDirectory !== 'all' && !norm.startsWith(selectedDirectory)) {
        continue;
      }
      if (node.kind === 'Module' || node.kind === 'ArchPattern') {
        baseNodes.push(node);
        baseNodeIds.add(node.id);
      }
    }

    // If no Module node exists for some files, create synthetic file nodes
    for (const [filePath, entities] of fileEntitiesMap.entries()) {
      if (selectedDirectory !== 'all' && !filePath.startsWith(selectedDirectory)) continue;
      if (!moduleNodeMap.has(filePath) && entities.length > 0) {
        const syntheticModule: GraphNode = {
          id: `mod:${filePath}`,
          kind: 'Module',
          name: filePath.split('/').pop() || filePath,
          qualifiedName: filePath,
          filePath: filePath,
          startLine: 1,
          endLine: 1,
          description: `${entities.length} entities`,
          metadata: JSON.stringify({ synthetic: true, entityCount: entities.length }),
        };
        baseNodes.push(syntheticModule);
        baseNodeIds.add(syntheticModule.id);
      }
    }

    // Expand modules that are in expandedModuleIds
    const expandedChildNodes: GraphNode[] = [];
    const parentChildEdges: GraphEdge[] = [];

    for (const moduleId of expandedModuleIds) {
      // Find module node
      const modNode = baseNodes.find(n => n.id === moduleId);
      if (!modNode) continue;
      const normPath = modNode.filePath.replace(/\\/g, '/');
      const children = fileEntitiesMap.get(normPath) || [];

      for (const child of children) {
        if (child.id === modNode.id) continue; // skip self
        if (kindFilter !== 'all' && child.kind !== kindFilter) continue;
        expandedChildNodes.push(child);
        baseNodeIds.add(child.id);

        parentChildEdges.push({
          fromId: modNode.id,
          toId: child.id,
          kind: 'CONTAINS',
          weight: 1,
        });
      }
    }

    const allVisNodes = [...baseNodes, ...expandedChildNodes];

    // Compute inter-module aggregated dependencies
    // If an entity in file A has an edge to an entity in file B, create an aggregated edge fileA -> fileB
    const entityToFile = new Map<string, string>();
    for (const [fPath, entities] of fileEntitiesMap.entries()) {
      for (const ent of entities) {
        entityToFile.set(ent.id, fPath);
      }
    }

    const aggEdgeMap = new Map<string, { fromId: string; toId: string; count: number }>();
    for (const e of edges) {
      const srcFile = entityToFile.get(e.fromId);
      const dstFile = entityToFile.get(e.toId);
      if (srcFile && dstFile && srcFile !== dstFile) {
        const srcMod = moduleNodeMap.get(srcFile) || baseNodes.find(n => n.filePath === srcFile);
        const dstMod = moduleNodeMap.get(dstFile) || baseNodes.find(n => n.filePath === dstFile);
        if (srcMod && dstMod && baseNodeIds.has(srcMod.id) && baseNodeIds.has(dstMod.id)) {
          const key = `${srcMod.id}->${dstMod.id}`;
          if (!aggEdgeMap.has(key)) {
            aggEdgeMap.set(key, { fromId: srcMod.id, toId: dstMod.id, count: 0 });
          }
          aggEdgeMap.get(key)!.count += 1;
        }
      }
    }

    const aggEdges: GraphEdge[] = Array.from(aggEdgeMap.values()).map(a => ({
      fromId: a.fromId,
      toId: a.toId,
      kind: 'DEPENDS_ON',
      weight: Math.min(4, Math.max(1, Math.log2(a.count + 1))),
    }));

    // Direct edges between visible nodes (for expanded children)
    const directChildEdges = edges.filter(
      e => baseNodeIds.has(e.fromId) && baseNodeIds.has(e.toId) &&
           (expandedChildNodes.some(c => c.id === e.fromId || c.id === e.toId))
    );

    const allVisEdges = [...aggEdges, ...parentChildEdges, ...directChildEdges];

    return {
      visibleNodes: allVisNodes,
      visibleEdges: allVisEdges,
      aggregatedEdges: aggEdges,
    };
  }, [viewMode, selectedNode, focusDepth, nodes, edges, allNodes, selectedDirectory, expandedModuleIds, fileEntitiesMap, moduleNodeMap, kindFilter]);

  // Toggle expand / collapse of a module
  const toggleExpandModule = useCallback((moduleId: string) => {
    setExpandedModuleIds(prev => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }, []);

  const expandAllModules = useCallback(() => {
    const allModIds = new Set<string>();
    for (const n of allNodes) {
      if (n.kind === 'Module' || n.id.startsWith('mod:')) {
        allModIds.add(n.id);
      }
    }
    setExpandedModuleIds(allModIds);
  }, [allNodes]);

  const collapseAllModules = useCallback(() => {
    setExpandedModuleIds(new Set());
  }, []);

  // Compute Layout Positions using Force Simulation
  useEffect(() => {
    if (visibleNodes.length === 0) return;
    const canvas = canvasRef.current;
    const W = canvas ? canvas.width || 1000 : 1000;
    const H = canvas ? canvas.height || 650 : 650;

    const currentPositions = positionsRef.current;
    const nextPositions = new Map<string, NodePosition>();

    // Initialize positions
    visibleNodes.forEach((node, i) => {
      const existing = currentPositions.get(node.id);
      const isMod = node.kind === 'Module' || node.kind === 'ArchPattern';
      const normPath = (node.filePath || '').replace(/\\/g, '/');
      const childCount = fileEntitiesMap.get(normPath)?.length || 0;

      if (existing) {
        nextPositions.set(node.id, {
          ...existing,
          radius: isMod ? 18 : 8,
          isModule: isMod,
          childCount,
        });
      } else {
        // If it's a child of an expanded module, place near its parent
        const parentMod = visibleNodes.find(
          n => (n.kind === 'Module' || n.id.startsWith('mod:')) &&
               n.filePath.replace(/\\/g, '/') === normPath &&
               n.id !== node.id
        );

        if (parentMod && nextPositions.has(parentMod.id)) {
          const parentPos = nextPositions.get(parentMod.id)!;
          const angle = Math.random() * Math.PI * 2;
          const dist = 35 + Math.random() * 45;
          nextPositions.set(node.id, {
            x: parentPos.x + Math.cos(angle) * dist,
            y: parentPos.y + Math.sin(angle) * dist,
            vx: 0,
            vy: 0,
            radius: 8,
            isModule: false,
            parentModuleId: parentMod.id,
            childCount: 0,
          });
        } else {
          const angle = (i / visibleNodes.length) * Math.PI * 2;
          const r = isMod ? 180 + Math.random() * 140 : 260 + Math.random() * 120;
          nextPositions.set(node.id, {
            x: W / 2 + Math.cos(angle) * r,
            y: H / 2 + Math.sin(angle) * r,
            vx: 0,
            vy: 0,
            radius: isMod ? 18 : 8,
            isModule: isMod,
            childCount,
          });
        }
      }
    });

    // Run iterative force steps
    const idSet = new Set(visibleNodes.map(n => n.id));
    const activeEdges = visibleEdges.filter(e => idSet.has(e.fromId) && idSet.has(e.toId));

    const iterations = Math.min(100, Math.max(40, 200 - visibleNodes.length));
    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations;

      // 1. Repulsion between all nodes
      for (let i = 0; i < visibleNodes.length; i++) {
        for (let j = i + 1; j < visibleNodes.length; j++) {
          const a = nextPositions.get(visibleNodes[i].id)!;
          const b = nextPositions.get(visibleNodes[j].id)!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const minDist = (a.radius + b.radius) * 2.5;

          const repulsion = (minDist * minDist * 80 * alpha) / (dist * dist);
          const fx = (dx / dist) * repulsion;
          const fy = (dy / dist) * repulsion;

          a.x -= fx;
          a.y -= fy;
          b.x += fx;
          b.y += fy;
        }
      }

      // 2. Attraction along edges
      for (const edge of activeEdges) {
        const a = nextPositions.get(edge.fromId);
        const b = nextPositions.get(edge.toId);
        if (!a || !b) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const targetDist = edge.kind === 'CONTAINS' ? 45 : 120;
        const force = (dist - targetDist) * 0.04 * alpha;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        a.x += fx;
        a.y += fy;
        b.x -= fx;
        b.y -= fy;
      }

      // 3. Center gravity
      for (const p of nextPositions.values()) {
        p.x += (W / 2 - p.x) * 0.015 * alpha;
        p.y += (H / 2 - p.y) * 0.015 * alpha;
      }
    }

    positionsRef.current = nextPositions;
    setAnimTrigger(prev => prev + 1);
  }, [visibleNodes, visibleEdges, fileEntitiesMap]);

  // Center / Fit to screen helper
  const fitToScreen = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || positionsRef.current.size === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    positionsRef.current.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });

    const graphWidth = maxX - minX + 100;
    const graphHeight = maxY - minY + 100;
    const canvasWidth = canvas.width || 1000;
    const canvasHeight = canvas.height || 650;

    const scaleX = canvasWidth / graphWidth;
    const scaleY = canvasHeight / graphHeight;
    const scale = Math.min(1.4, Math.max(0.4, Math.min(scaleX, scaleY) * 0.85));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    setTransform({
      x: canvasWidth / 2 - centerX * scale,
      y: canvasHeight / 2 - centerY * scale,
      scale,
    });
  }, []);

  // Initial fit
  useEffect(() => {
    fitToScreen();
  }, [viewMode, fitToScreen]);

  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    const W = (canvas.width = container ? container.clientWidth : 1000);
    const H = (canvas.height = container ? container.clientHeight : 650);

    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    // Draw background grid dots
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    const gridSize = 40;
    const startX = Math.floor((-transform.x / transform.scale) / gridSize) * gridSize;
    const endX = startX + (W / transform.scale) + gridSize;
    const startY = Math.floor((-transform.y / transform.scale) / gridSize) * gridSize;
    const endY = startY + (H / transform.scale) + gridSize;

    for (let x = startX; x < endX; x += gridSize) {
      for (let y = startY; y < endY; y += gridSize) {
        ctx.fillRect(x, y, 1.5, 1.5);
      }
    }

    const positions = positionsRef.current;
    const hoveredId = hoveredNode?.id;
    const selectedId = selectedNode?.id;

    // Draw Edges
    for (const edge of visibleEdges) {
      const a = positions.get(edge.fromId);
      const b = positions.get(edge.toId);
      if (!a || !b) continue;

      const isConnected = edge.fromId === hoveredId || edge.toId === hoveredId ||
                          edge.fromId === selectedId || edge.toId === selectedId;

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);

      if (edge.kind === 'CONTAINS') {
        ctx.strokeStyle = isConnected ? '#818cf8' : 'rgba(99, 102, 241, 0.35)';
        ctx.lineWidth = isConnected ? 2 : 1;
        ctx.setLineDash([3, 3]);
      } else if (edge.kind === 'DEPENDS_ON') {
        ctx.strokeStyle = isConnected ? '#38bdf8' : 'rgba(56, 189, 248, 0.3)';
        ctx.lineWidth = isConnected ? 2.5 : Math.min(3, 1 + (edge.weight || 1) * 0.5);
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = isConnected ? '#a78bfa' : 'rgba(156, 163, 175, 0.2)';
        ctx.lineWidth = isConnected ? 2 : 1;
        ctx.setLineDash([]);
      }

      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Nodes
    for (const node of visibleNodes) {
      const p = positions.get(node.id);
      if (!p) continue;

      const isSelected = selectedNode?.id === node.id;
      const isHovered = hoveredNode?.id === node.id;
      const isExpanded = expandedModuleIds.has(node.id);
      const isModule = node.kind === 'Module' || node.kind === 'ArchPattern';
      const color = KIND_COLORS[node.kind] || '#6366f1';

      // Outer glow for selected or hovered
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius + 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(99, 102, 241, 0.35)' : 'rgba(255, 255, 255, 0.15)';
        ctx.fill();
      }

      // Base circle
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = isModule ? (isExpanded ? '#1e1b4b' : '#111827') : '#0f172a';
      ctx.fill();

      // Border
      ctx.strokeStyle = isSelected ? '#ffffff' : color;
      ctx.lineWidth = isSelected ? 3 : isModule ? 2.5 : 1.5;
      ctx.stroke();

      // Inner icon or dot
      if (isModule) {
        // Draw module icon/initial or badge
        ctx.fillStyle = color;
        ctx.font = 'bold 11px "Inter", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        if (node.kind === 'ArchPattern') {
          ctx.fillText('◈', p.x, p.y);
        } else {
          // Show entity count badge inside or indicator
          const childCount = p.childCount || 0;
          ctx.fillText(childCount > 0 ? `${childCount}` : 'M', p.x, p.y);
        }

        // Expand / Collapse indicator pill on module
        if (p.childCount && p.childCount > 0) {
          const pillX = p.x + p.radius * 0.7;
          const pillY = p.y - p.radius * 0.7;
          ctx.beginPath();
          ctx.arc(pillX, pillY, 6, 0, Math.PI * 2);
          ctx.fillStyle = isExpanded ? '#ec4899' : '#3b82f6';
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 9px "Inter", sans-serif';
          ctx.fillText(isExpanded ? '−' : '+', pillX, pillY);
        }
      } else {
        // Child entity node: draw solid color core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      // Node Label
      const showLabel = isModule || isSelected || isHovered || transform.scale > 0.9;
      if (showLabel) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = isModule ? '600 12px "Inter", sans-serif' : '400 10px "IBM Plex Mono", monospace';

        const labelText = isModule
          ? (node.name || node.qualifiedName.split('/').pop() || '')
          : node.name;

        const textX = p.x + p.radius + 5;
        const textY = p.y;

        // Label background pill for readability
        const textWidth = ctx.measureText(labelText).width;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(textX - 2, textY - 7, textWidth + 6, 15);

        ctx.fillStyle = isSelected ? '#ffffff' : isModule ? '#f3f4f6' : '#cbd5e1';
        ctx.fillText(labelText, textX + 1, textY + 1);
      }
    }

    ctx.restore();
  }, [transform, visibleNodes, visibleEdges, selectedNode, hoveredNode, expandedModuleIds, animTrigger]);

  // Mouse drag pan handler
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDragging) {
      setTransform(prev => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      }));
      return;
    }

    // Hover detection
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseCanvasX = (e.clientX - rect.left - transform.x) / transform.scale;
    const mouseCanvasY = (e.clientY - rect.top - transform.y) / transform.scale;

    let found: GraphNode | null = null;
    const positions = positionsRef.current;

    for (const node of visibleNodes) {
      const p = positions.get(node.id);
      if (!p) continue;
      const dx = p.x - mouseCanvasX;
      const dy = p.y - mouseCanvasY;
      const hitRadius = p.radius + 6;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        found = node;
        break;
      }
    }

    setHoveredNode(found);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newScale = Math.min(3.5, Math.max(0.2, transform.scale * zoomFactor));

    setTransform(prev => ({
      scale: newScale,
      x: mouseX - (mouseX - prev.x) * (newScale / prev.scale),
      y: mouseY - (mouseY - prev.y) * (newScale / prev.scale),
    }));
  };

  // Click on node
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left - transform.x) / transform.scale;
    const clickY = (e.clientY - rect.top - transform.y) / transform.scale;

    const positions = positionsRef.current;
    for (const node of visibleNodes) {
      const p = positions.get(node.id);
      if (!p) continue;
      const dx = p.x - clickX;
      const dy = p.y - clickY;
      const hitRadius = p.radius + 6;

      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        // If it's a module, toggle expand
        if (node.kind === 'Module' || node.id.startsWith('mod:')) {
          toggleExpandModule(node.id);
        }
        onSelectNode(node);
        return;
      }
    }
  };

  // Zoom controls
  const handleZoomIn = () => {
    setTransform(prev => ({ ...prev, scale: Math.min(3.5, prev.scale * 1.25) }));
  };

  const handleZoomOut = () => {
    setTransform(prev => ({ ...prev, scale: Math.max(0.2, prev.scale * 0.8) }));
  };

  const handleResetZoom = () => {
    setTransform({ x: 0, y: 0, scale: 1 });
  };

  // Count active stats
  const moduleCount = useMemo(() => {
    return allNodes.filter(n => n.kind === 'Module' || n.id.startsWith('mod:')).length;
  }, [allNodes]);

  return (
    <div className="graph-explorer-container">
      {/* Top Header / View Mode & Filter Toolbar */}
      <div className="graph-top-toolbar">
        {/* View Mode Switcher */}
        <div className="view-mode-tabs">
          <button
            className={`view-mode-btn ${viewMode === 'modules' ? 'active' : ''}`}
            onClick={() => setViewMode('modules')}
            title="High-level modules & architecture with expandable inner details"
          >
            <Layers size={15} />
            <span>Architecture Modules</span>
            <span className="mode-badge">{moduleCount}</span>
          </button>

          <button
            className={`view-mode-btn ${viewMode === 'all' ? 'active' : ''}`}
            onClick={() => setViewMode('all')}
            title="All indexed entities across the codebase"
          >
            <Box size={15} />
            <span>All Entities</span>
            <span className="mode-badge">{allNodes.length}</span>
          </button>

          {selectedNode && (
            <button
              className={`view-mode-btn ${viewMode === 'focus' ? 'active' : ''}`}
              onClick={() => setViewMode('focus')}
              title="Focus exclusively on the selected entity and its direct connections"
            >
              <Eye size={15} />
              <span>Focused: {selectedNode.name}</span>
            </button>
          )}
        </div>

        {/* Search & Filters */}
        <div className="graph-filter-actions">
          {/* Search Box */}
          <div className="search-box">
            <Search size={15} />
            <input
              type="text"
              placeholder="Search functions, classes, modules…"
              value={searchQuery}
              onChange={e => onSearch(e.target.value)}
            />
            {searchQuery && (
              <button className="search-clear-btn" onClick={() => onSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>

          {/* Directory Filter */}
          <div className="filter-group">
            <Folder size={14} className="filter-icon" />
            <select
              className="dir-filter-select"
              value={selectedDirectory}
              onChange={e => setSelectedDirectory(e.target.value)}
            >
              <option value="all">All Folders ({directoryList.length})</option>
              {directoryList.map(dir => (
                <option key={dir} value={dir}>{dir}</option>
              ))}
            </select>
          </div>

          {/* Kind Filter */}
          <select
            className="kind-filter"
            value={kindFilter}
            onChange={e => onKindFilter(e.target.value)}
          >
            <option value="all">All Types ({allNodes.length})</option>
            {Object.keys(KIND_COLORS).map(k => {
              const count = allNodes.filter(n => n.kind === k).length;
              if (count === 0) return null;
              return (
                <option key={k} value={k}>{k} ({count})</option>
              );
            })}
          </select>

          {/* Expand / Collapse Modules Buttons (In Modules View) */}
          {viewMode === 'modules' && (
            <div className="expand-collapse-actions">
              <button
                className="action-pill-btn"
                onClick={expandAllModules}
                title="Expand all modules to show their inner classes and functions"
              >
                Expand All
              </button>
              <button
                className="action-pill-btn"
                onClick={collapseAllModules}
                title="Collapse all modules to high-level architecture view"
              >
                Collapse All
              </button>
            </div>
          )}

          {/* Subgraph Focus Depth Slider (In Focus View) */}
          {viewMode === 'focus' && (
            <div className="depth-selector">
              <span className="depth-label">Depth:</span>
              {[1, 2, 3].map(d => (
                <button
                  key={d}
                  className={`depth-btn ${focusDepth === d ? 'active' : ''}`}
                  onClick={() => setFocusDepth(d)}
                >
                  {d} Hop{d > 1 ? 's' : ''}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search Autocomplete Results */}
      {searchResults.length > 0 && (
        <div className="search-results-floating">
          {searchResults.slice(0, 8).map(r => (
            <button
              key={r.id}
              className="search-result-item"
              onClick={() => {
                onSelectNode(r);
                onSearch('');
                // If in modules mode, expand its parent module
                const norm = (r.filePath || '').replace(/\\/g, '/');
                const mod = moduleNodeMap.get(norm);
                if (mod) toggleExpandModule(mod.id);
              }}
            >
              <span className="sr-kind-badge" style={{ backgroundColor: KIND_COLORS[r.kind] || '#6366f1' }}>
                {r.kind}
              </span>
              <span className="sr-title">{r.name}</span>
              <span className="sr-path">{r.filePath}</span>
            </button>
          ))}
        </div>
      )}

      {/* Main Canvas + Floating Controls + Inspector Layout */}
      <div className="graph-workspace">
        <div className="graph-canvas-container" ref={containerRef}>
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onWheel={handleWheel}
            onClick={handleCanvasClick}
            style={{ cursor: isDragging ? 'grabbing' : 'crosshair' }}
          />

          {/* Floating Canvas Navigation Controls */}
          <div className="canvas-floating-controls">
            <button onClick={handleZoomIn} title="Zoom In"><ZoomIn size={16} /></button>
            <button onClick={handleZoomOut} title="Zoom Out"><ZoomOut size={16} /></button>
            <button onClick={handleResetZoom} title="Reset Zoom (1:1)"><RotateCcw size={16} /></button>
            <button onClick={fitToScreen} title="Fit Graph to Viewport"><Maximize2 size={16} /></button>
          </div>

          {/* Status info overlay */}
          <div className="canvas-status-badge">
            <span>Showing <strong>{visibleNodes.length}</strong> nodes, <strong>{visibleEdges.length}</strong> edges</span>
            {viewMode === 'modules' && (
              <span className="status-sub">
                ({expandedModuleIds.size} of {moduleCount} modules expanded — click any module to drill down)
              </span>
            )}
          </div>

          {/* Hover Tooltip */}
          {hoveredNode && (
            <div className="graph-hover-tooltip">
              <div className="tooltip-header">
                <span className="tooltip-kind" style={{ color: KIND_COLORS[hoveredNode.kind] }}>
                  {hoveredNode.kind}
                </span>
                <span className="tooltip-name">{hoveredNode.name}</span>
              </div>
              <div className="tooltip-path">{hoveredNode.filePath}:{hoveredNode.startLine}</div>
              {hoveredNode.description && (
                <div className="tooltip-desc">{hoveredNode.description}</div>
              )}
            </div>
          )}

          {/* Legend Bar */}
          <div className="graph-interactive-legend">
            {Object.entries(KIND_COLORS).slice(0, 8).map(([kind, color]) => (
              <button
                key={kind}
                className={`legend-pill ${kindFilter === kind ? 'active' : ''}`}
                onClick={() => onKindFilter(kindFilter === kind ? 'all' : kind)}
              >
                <span className="legend-dot" style={{ background: color }} />
                <span>{kind}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Rich Node Inspector Drawer */}
        {selectedNode && (
          <aside className="node-inspector-drawer">
            <div className="inspector-header">
              <div className="inspector-kind-badge" style={{ backgroundColor: `${KIND_COLORS[selectedNode.kind]}22`, color: KIND_COLORS[selectedNode.kind] }}>
                {selectedNode.kind}
              </div>
              <button className="inspector-close-btn" onClick={onCloseNode} title="Close Inspector">
                <X size={16} />
              </button>
            </div>

            <h3 className="inspector-title">{selectedNode.name}</h3>
            <p className="inspector-qualified">{selectedNode.qualifiedName}</p>

            <div className="inspector-meta-row">
              <span className="meta-file">{selectedNode.filePath}:{selectedNode.startLine}</span>
              {selectedNode.endLine > selectedNode.startLine && (
                <span className="meta-lines">({selectedNode.endLine - selectedNode.startLine + 1} lines)</span>
              )}
            </div>

            {/* Description / Semantic summary */}
            {selectedNode.description && (
              <div className="inspector-section">
                <div className="section-label">
                  <Sparkles size={13} className="sparkle-icon" />
                  <span>Description</span>
                </div>
                <p className="inspector-description">{selectedNode.description}</p>
              </div>
            )}

            {/* Quick Actions */}
            <div className="inspector-actions">
              <button
                className="inspector-action-btn primary"
                onClick={() => setViewMode('focus')}
              >
                <Eye size={14} />
                <span>Focus Subgraph</span>
              </button>

              {onNavigateToImpact && (
                <button
                  className="inspector-action-btn"
                  onClick={() => onNavigateToImpact(selectedNode.filePath)}
                >
                  <ShieldAlert size={14} />
                  <span>Analyze Impact</span>
                </button>
              )}

              {onNavigateToMindmap && (
                <button
                  className="inspector-action-btn"
                  onClick={() => onNavigateToMindmap(selectedNode.id)}
                >
                  <GitBranch size={14} />
                  <span>View in Mindmap</span>
                </button>
              )}
            </div>

            {/* Connected Neighborhood */}
            {neighborhood && neighborhood.nodes && (
              <div className="inspector-neighbors-section">
                <div className="section-label">
                  <span>Connected Entities ({neighborhood.nodes.length})</span>
                </div>
                <div className="neighbor-cards-list">
                  {neighborhood.nodes.slice(0, 25).map((n: GraphNode) => {
                    const displayName = n.name || (n.filePath ? n.filePath.split(/[\/\\]/).pop() : n.qualifiedName) || 'Entity';
                    return (
                      <button
                        key={n.id}
                        className="neighbor-card"
                        onClick={() => onSelectNode(n)}
                        title={`${displayName} (${n.kind}) - ${n.filePath || ''}`}
                      >
                        <span className="neighbor-kind-dot" style={{ background: KIND_COLORS[n.kind] || '#6366f1' }} />
                        <div className="neighbor-info">
                          <span className="neighbor-name">{displayName}</span>
                          <span className="neighbor-kind">{n.kind}{n.filePath ? ` · ${n.filePath}` : ''}</span>
                        </div>
                        <ChevronRight size={14} className="neighbor-arrow" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
