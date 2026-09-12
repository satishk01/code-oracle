/**
 * ToolRegistry unit tests.
 *
 * Covers register/get/execute, risk levels, enable/disable, duplicate
 * registration, toOpenAITools serialization, and unregister.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, defineTool } from '../registry.js';

function makeTool(name: string, riskLevel: 'read' | 'write' | 'destructive' = 'read') {
  return defineTool({
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
    },
    riskLevel,
    handler: async (args) => ({ ok: true, value: String(args.value ?? '') }),
  });
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool by name', () => {
    const reg = new ToolRegistry();
    const tool = makeTool('foo');
    reg.register(tool);

    const got = reg.get('foo');
    expect(got).toBeDefined();
    expect(got?.schema.name).toBe('foo');
    expect(got?.riskLevel).toBe('read');
  });

  it('throws on duplicate registration', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('dup'));
    expect(() => reg.register(makeTool('dup'))).toThrow(/already registered/);
  });

  it('returns undefined for unknown tools', () => {
    const reg = new ToolRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('executes a registered tool and returns its result', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('echo'));
    const result = await reg.execute('echo', { value: 'hello' });
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  it('throws when executing an unregistered tool', async () => {
    const reg = new ToolRegistry();
    await expect(reg.execute('ghost')).rejects.toThrow(/not registered/);
  });

  it('throws when executing a disabled tool', async () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('off'));
    reg.disable('off');
    await expect(reg.execute('off')).rejects.toThrow(/disabled/);
  });

  it('tracks risk levels for registered tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('reader', 'read'));
    reg.register(makeTool('writer', 'write'));
    reg.register(makeTool('killer', 'destructive'));

    expect(reg.get('reader')?.riskLevel).toBe('read');
    expect(reg.get('writer')?.riskLevel).toBe('write');
    expect(reg.get('killer')?.riskLevel).toBe('destructive');
  });

  it('enable/disable affects isEnabled and list', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('a'));
    reg.register(makeTool('b'));

    expect(reg.isEnabled('a')).toBe(true);
    reg.disable('a');
    expect(reg.isEnabled('a')).toBe(false);
    expect(reg.list().map((t) => t.schema.name)).toEqual(['b']);

    reg.enable('a');
    expect(reg.isEnabled('a')).toBe(true);
    expect(reg.list().map((t) => t.schema.name).sort()).toEqual(['a', 'b']);
  });

  it('names() includes disabled tools', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('x'));
    reg.register(makeTool('y'));
    reg.disable('x');
    expect(reg.names().sort()).toEqual(['x', 'y']);
  });

  it('toOpenAITools serializes enabled tools in OpenAI format', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('alpha'));
    reg.register(makeTool('beta'));
    reg.disable('beta');

    const tools = reg.toOpenAITools();
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('alpha');
    expect(tools[0].function.parameters.type).toBe('object');
  });

  it('unregister removes a tool and cleans up disabled state', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('temp'));
    reg.disable('temp');
    expect(reg.unregister('temp')).toBe(true);
    expect(reg.get('temp')).toBeUndefined();
    expect(reg.names()).not.toContain('temp');
    // Re-registering after unregister should work.
    expect(() => reg.register(makeTool('temp'))).not.toThrow();
  });
});
