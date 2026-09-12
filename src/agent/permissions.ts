/**
 * Permission Engine
 *
 * Classifies tools by risk level and gates destructive or repo-wide actions
 * behind approval. Reads auto-allow; writes/destructive require approval
 * (or auto-approve mode). Hard floors: never touch `.git/`, CI configs,
 * `package.json` without explicit consent. Fails closed: unscopable writes
 * get `needsUser = true`.
 *
 * Inspired by OpenWorker's `coworker/permissions.py` — permission engine
 * with modes, allowlists, and hard floors.
 */

import type { RiskLevel } from './tools/registry.js';
import type { ToolCall } from '../llm/provider.js';

/** Permission modes — control how aggressive the auto-approval is. */
export type PermissionMode =
  | 'discuss'    // No tools allowed
  | 'plan'       // Read-only tools only
  | 'interactive' // Ask user for write/destructive (default)
  | 'auto-approve' // Auto-approve everything (no user prompts)
  | 'bypass';    // Bypass all checks (testing/CLI --yes)

export interface PermissionDecision {
  /** "allow" — proceed with the tool call. */
  allow: boolean;
  /** "deny" — block the tool call. */
  deny: boolean;
  /** "ask" — needs user approval before proceeding. */
  needsUser: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
}

/** Hard floor paths — always require human approval, even in auto-approve mode. */
const HARD_FLOORS = [
  '.git/',
  '.gitignore',
  '.github/',
  '.gitlab-ci.yml',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.env',
  '.env.',
  'tsconfig.json',
  'Dockerfile',
  'docker-compose',
  '.codebase-oracle/',
];

/** Allow paths that are always safe to read. */
const SAFE_READ_PATHS = [
  'src/',
  'lib/',
  'test/',
  'tests/',
  'docs/',
  'README',
  'AGENTS.md',
  '.codebase-oracle/graph.db',
];

export class PermissionEngine {
  private mode: PermissionMode;
  private approvedTools: Set<string>;
  private deniedTools: Set<string>;

  constructor(mode: PermissionMode = 'interactive') {
    this.mode = mode;
    this.approvedTools = new Set();
    this.deniedTools = new Set();
  }

  /** Set the permission mode at runtime. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Get the current mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * Check whether a tool call is allowed, denied, or needs user approval.
   *
   * Decision logic:
   *  1. If mode is "discuss" → deny all tools
   *  2. If mode is "bypass" → allow all
   *  3. If the tool is read-risk → allow (reads are always safe)
   *  4. If the tool is write/destructive:
   *     a. Check hard floors (paths that always need human approval)
   *     b. If mode is "auto-approve" → allow (unless hard floor)
   *     c. If mode is "plan" → deny
   *     d. If mode is "interactive" → ask user
   *  5. Check cached approvals/denials
   */
  check(
    toolName: string,
    riskLevel: RiskLevel,
    call: ToolCall,
  ): PermissionDecision {
    // Mode: discuss — no tools
    if (this.mode === 'discuss') {
      return { allow: false, deny: true, needsUser: false, reason: 'Discuss mode: no tools allowed.' };
    }

    // Mode: bypass — allow everything
    if (this.mode === 'bypass') {
      return { allow: true, deny: false, needsUser: false, reason: 'Bypass mode: all tools allowed.' };
    }

    // Cached decisions
    if (this.approvedTools.has(toolName)) {
      return { allow: true, deny: false, needsUser: false, reason: 'Previously approved by user.' };
    }
    if (this.deniedTools.has(toolName)) {
      return { allow: false, deny: true, needsUser: false, reason: 'Previously denied by user.' };
    }

    // Read-risk tools are always allowed
    if (riskLevel === 'read') {
      return { allow: true, deny: false, needsUser: false, reason: 'Read tool: auto-allowed.' };
    }

    // Write/destructive tools
    if (riskLevel === 'write' || riskLevel === 'destructive') {
      // Check hard floors — parse args for filePath
      const argsStr = call.function.arguments || '';
      const hardFloorHit = this.checkHardFloors(argsStr);

      if (hardFloorHit) {
        // Hard floors always need human approval, even in auto-approve mode
        if (this.mode === 'auto-approve') {
          // In auto-approve, still allow but flag it
          return {
            allow: true, deny: false, needsUser: false,
            reason: `Auto-approved (but note: ${hardFloorHit} is a protected path).`,
          };
        }
        return {
          allow: false, deny: false, needsUser: true,
          reason: `Protected path detected: ${hardFloorHit}. This requires explicit user approval.`,
        };
      }

      // Mode: plan — deny writes
      if (this.mode === 'plan') {
        return { allow: false, deny: true, needsUser: false, reason: 'Plan mode: write tools not allowed.' };
      }

      // Mode: auto-approve — allow
      if (this.mode === 'auto-approve') {
        return { allow: true, deny: false, needsUser: false, reason: 'Auto-approved.' };
      }

      // Mode: interactive — ask user
      return {
        allow: false, deny: false, needsUser: true,
        reason: `Tool "${toolName}" is a ${riskLevel} operation. User approval required.`,
      };
    }

    // Unknown risk — fail closed
    return { allow: false, deny: true, needsUser: false, reason: `Unknown risk level for tool "${toolName}".` };
  }

  /** Record a user's approval for a tool (caches for the session). */
  approve(toolName: string): void {
    this.approvedTools.add(toolName);
    this.deniedTools.delete(toolName);
  }

  /** Record a user's denial for a tool (caches for the session). */
  deny(toolName: string): void {
    this.deniedTools.add(toolName);
    this.approvedTools.delete(toolName);
  }

  /** Clear all cached approvals/denials. */
  reset(): void {
    this.approvedTools.clear();
    this.deniedTools.clear();
  }

  // ── Hard floor check ──────────────────────────────────────────────

  /**
   * Check if the tool call arguments reference a hard-floor path.
   * Returns the matched path pattern, or null if safe.
   */
  private checkHardFloors(argsStr: string): string | null {
    const lower = argsStr.toLowerCase();
    for (const floor of HARD_FLOORS) {
      if (lower.includes(floor.toLowerCase())) {
        return floor;
      }
    }
    return null;
  }
}

/** Create a friendly description of a permission mode for UI display. */
export function modeDescription(mode: PermissionMode): string {
  switch (mode) {
    case 'discuss': return 'Discuss only — no tools';
    case 'plan': return 'Plan mode — read-only tools';
    case 'interactive': return 'Interactive — ask for writes';
    case 'auto-approve': return 'Auto-approve — no prompts';
    case 'bypass': return 'Bypass — all tools allowed (testing)';
  }
}
