/**
 * PermissionEngine unit tests.
 *
 * Covers all five modes, read auto-allow, write/destructive gating,
 * hard floors (protected paths), and approve/deny caching.
 */
import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../permissions.js';
import type { ToolCall } from '../../llm/provider.js';

let idc = 0;
function call(args: unknown): ToolCall {
  idc += 1;
  return {
    id: `tc_${idc}`,
    type: 'function',
    function: {
      name: 'some_tool',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

describe('PermissionEngine', () => {
  describe('modes', () => {
    it('discuss mode denies all tools (even reads)', () => {
      const p = new PermissionEngine('discuss');
      const d = p.check('read_file', 'read', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(false);
      expect(d.deny).toBe(true);
      expect(d.needsUser).toBe(false);
    });

    it('bypass mode allows all tools (even destructive)', () => {
      const p = new PermissionEngine('bypass');
      const d = p.check('delete_file', 'destructive', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(true);
      expect(d.deny).toBe(false);
    });

    it('plan mode allows reads but denies writes', () => {
      const p = new PermissionEngine('plan');
      const read = p.check('read_file', 'read', call({ filePath: 'src/a.ts' }));
      expect(read.allow).toBe(true);

      const write = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(write.allow).toBe(false);
      expect(write.deny).toBe(true);
    });

    it('auto-approve mode allows writes without prompting', () => {
      const p = new PermissionEngine('auto-approve');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(true);
      expect(d.needsUser).toBe(false);
    });

    it('interactive mode asks the user for writes', () => {
      const p = new PermissionEngine('interactive');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(false);
      expect(d.deny).toBe(false);
      expect(d.needsUser).toBe(true);
    });
  });

  describe('read tools', () => {
    it('auto-allows read-risk tools in any non-discuss mode', () => {
      for (const mode of ['plan', 'interactive', 'auto-approve', 'bypass'] as const) {
        const p = new PermissionEngine(mode);
        const d = p.check('search_nodes', 'read', call({ query: 'foo' }));
        expect(d.allow).toBe(true);
      }
    });
  });

  describe('hard floors', () => {
    it('flags .git/ paths as needing user approval in interactive mode', () => {
      const p = new PermissionEngine('interactive');
      const d = p.check('write_file', 'write', call({ filePath: '.git/config' }));
      expect(d.needsUser).toBe(true);
      expect(d.reason).toContain('.git/');
    });

    it('flags package.json as a protected path', () => {
      const p = new PermissionEngine('interactive');
      const d = p.check('write_file', 'write', call({ filePath: 'package.json' }));
      expect(d.needsUser).toBe(true);
      expect(d.reason).toContain('package.json');
    });

    it('flags .env as a protected path', () => {
      const p = new PermissionEngine('interactive');
      const d = p.check('write_file', 'write', call({ filePath: '.env' }));
      expect(d.needsUser).toBe(true);
    });

    it('auto-approve still allows hard-floor writes but notes the protected path', () => {
      const p = new PermissionEngine('auto-approve');
      const d = p.check('write_file', 'write', call({ filePath: '.git/config' }));
      // auto-approve allows but the reason flags the protected path
      expect(d.allow).toBe(true);
      expect(d.reason).toContain('.git/');
    });

    it('plan mode denies regular (non-protected) writes', () => {
      const p = new PermissionEngine('plan');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.deny).toBe(true);
      expect(d.allow).toBe(false);
      expect(d.needsUser).toBe(false);
    });

    it('hard floors override plan mode and still require user approval', () => {
      // The hard-floor check runs before the plan-mode deny, so a protected
      // path surfaces as needsUser even in plan mode.
      const p = new PermissionEngine('plan');
      const d = p.check('write_file', 'write', call({ filePath: 'package.json' }));
      expect(d.needsUser).toBe(true);
      expect(d.allow).toBe(false);
    });
  });

  describe('approve/deny caching', () => {
    it('caches approvals so subsequent calls auto-allow', () => {
      const p = new PermissionEngine('interactive');
      p.approve('write_file');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(true);
      expect(d.reason).toMatch(/previously approved/i);
    });

    it('caches denials so subsequent calls auto-deny', () => {
      const p = new PermissionEngine('interactive');
      p.deny('write_file');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.deny).toBe(true);
      expect(d.reason).toMatch(/previously denied/i);
    });

    it('approve overrides a prior denial', () => {
      const p = new PermissionEngine('interactive');
      p.deny('write_file');
      p.approve('write_file');
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.allow).toBe(true);
    });

    it('reset clears cached approvals and denials', () => {
      const p = new PermissionEngine('interactive');
      p.approve('write_file');
      p.reset();
      const d = p.check('write_file', 'write', call({ filePath: 'src/a.ts' }));
      expect(d.needsUser).toBe(true);
    });
  });

  describe('mode switching', () => {
    it('setMode/getMode round-trip', () => {
      const p = new PermissionEngine('interactive');
      p.setMode('auto-approve');
      expect(p.getMode()).toBe('auto-approve');
    });
  });

  describe('unknown risk level', () => {
    it('fails closed (denies) for an unrecognized risk level', () => {
      const p = new PermissionEngine('interactive');
      const d = p.check('weird_tool', 'unknown' as any, call({}));
      expect(d.deny).toBe(true);
      expect(d.allow).toBe(false);
    });
  });
});
