/**
 * Tool Registry
 *
 * Central registry mapping tool name → { schema, handler, riskLevel }.
 * Schemas are JSON Schema objects exposed to the LLM so the model knows
 * what tools are available and how to call them. Handlers are plain TS
 * functions that the AgentEngine dispatches to.
 *
 * Inspired by OpenWorker's `coworker/tools/registry.py` — a single
 * registry that exposes tool schemas to the LLM and dispatches to
 * functions, with runtime enable/disable support.
 */

/** Risk classification for a tool — drives the permission engine. */
export type RiskLevel = 'read' | 'write' | 'destructive';

/**
 * A JSON-Schema description of a tool's parameters, in the OpenAI
 * tool-calling format (`type: "function"` → `function.parameters`).
 */
export interface ToolSchema {
  /** Tool name shown to the LLM. Must be unique within a registry. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * A registered tool specification.
 *
 * `handler` receives the parsed arguments object and returns a result
 * that will be serialized to JSON and fed back to the LLM as a tool
 * result message.
 */
export interface ToolSpec<TResult = unknown> {
  schema: ToolSchema;
  handler: (args: Record<string, unknown>) => Promise<TResult>;
  riskLevel: RiskLevel;
  /** Optional metadata for audit logging / UI display. */
  metadata?: Record<string, unknown>;
}

/** OpenAI-format tool definition, ready to send to a chat-completions API. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolSchema['parameters'];
  };
}

/**
 * Central tool registry. Tools are registered once at startup and
 * dispatched by name during the agent loop.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();
  private disabled = new Set<string>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(spec: ToolSpec): void {
    if (this.tools.has(spec.schema.name)) {
      throw new Error(`Tool already registered: ${spec.schema.name}`);
    }
    this.tools.set(spec.schema.name, spec);
  }

  /** Remove a tool from the registry. */
  unregister(name: string): boolean {
    this.disabled.delete(name);
    return this.tools.delete(name);
  }

  /** Temporarily disable a tool (it won't be offered to the LLM). */
  disable(name: string): void {
    this.disabled.add(name);
  }

  /** Re-enable a previously disabled tool. */
  enable(name: string): void {
    this.disabled.delete(name);
  }

  /** Get a tool spec by name, or undefined if not registered. */
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  /** Whether a tool is registered and currently enabled. */
  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  /** List all enabled tool specs. */
  list(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [name, spec] of this.tools) {
      if (!this.disabled.has(name)) out.push(spec);
    }
    return out;
  }

  /** List all tool names (enabled + disabled). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Return the OpenAI-format tool definitions for all enabled tools.
   * This is what gets sent in the `tools` field of a chat-completions
   * request when tool-calling is enabled.
   */
  toOpenAITools(): OpenAITool[] {
    return this.list().map(spec => ({
      type: 'function',
      function: {
        name: spec.schema.name,
        description: spec.schema.description,
        parameters: spec.schema.parameters,
      },
    }));
  }

  /**
   * Execute a tool by name with the given arguments.
   * Throws if the tool is not registered or is disabled.
   */
  async execute(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const spec = this.tools.get(name);
    if (!spec) throw new Error(`Tool not registered: ${name}`);
    if (this.disabled.has(name)) throw new Error(`Tool is disabled: ${name}`);
    return spec.handler(args);
  }
}

// ── Helper: build a ToolSpec concisely ─────────────────────────────

export interface DefineToolOptions<TResult = unknown> {
  name: string;
  description: string;
  parameters: ToolSchema['parameters'];
  handler: (args: Record<string, unknown>) => Promise<TResult>;
  riskLevel?: RiskLevel;
  metadata?: Record<string, unknown>;
}

/** Convenience function to define a tool spec. */
export function defineTool<TResult = unknown>(opts: DefineToolOptions<TResult>): ToolSpec<TResult> {
  return {
    schema: {
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
    },
    handler: opts.handler,
    riskLevel: opts.riskLevel ?? 'read',
    metadata: opts.metadata,
  };
}
