/**
 * Graph Q&A over an LLM provider
 *
 * Provides natural-language Q&A over the knowledge graph by:
 *  1. Searching the graph for relevant nodes
 *  2. Building a context from node descriptions + relationships
 *  3. Sending to an LLM provider (Ollama or Omniroute) for synthesis
 *
 * Falls back to graph-only answers if the LLM provider isn't reachable.
 *
 * Note: the class name `OllamaQA` is historical — it now works with any
 * {@link LLMProvider}. Pass a provider via the `provider` option, or legacy
 * `baseUrl`/`model` options to implicitly use an Ollama provider.
 */

import { GraphStore } from '../graph/store.js';
import {
  OllamaProvider,
  isToolCapable,
} from './provider.js';
import type {
  LLMProvider,
  ChatMessage,
} from './provider.js';
import { AgentEngine } from '../agent/index.js';
import type { AgentTurnResult } from '../agent/index.js';

export interface QAResult {
  answer: string;
  context: { nodeId: string; name: string; kind: string; relevance: string }[];
  model: string;
  fallback: boolean;
}

/**
 * Default system prompt template. `{context}` is replaced with the assembled
 * knowledge-graph context at query time. Users can override the entire prompt
 * via the `OLLAMA_SYSTEM_PROMPT` env var (or `systemPrompt` constructor option);
 * if the override contains `{context}`, the graph context is substituted there,
 * otherwise it is appended at the end.
 */
export const DEFAULT_SYSTEM_PROMPT = `You are a codebase analysis assistant. You answer questions about a software repository using the knowledge graph context provided below. Be specific, reference file paths and class/function names. If you don't have enough context, say so.

CODEBASE KNOWLEDGE GRAPH CONTEXT:
{context}`;

export interface OllamaQAOptions {
  /** Pre-built LLM provider (takes precedence over baseUrl/model). */
  provider?: LLMProvider;
  /** Legacy: Ollama base URL. Used only when `provider` is not given. */
  baseUrl?: string;
  /** Legacy: Ollama model name. Used only when `provider` is not given. */
  model?: string;
  /** Optional override for the Q&A system prompt. */
  systemPrompt?: string;
}

export class OllamaQA {
  private provider: LLMProvider;
  private systemPromptOverride: string | undefined;

  constructor(
    private store: GraphStore,
    opts: OllamaQAOptions = {},
  ) {
    if (opts.provider) {
      this.provider = opts.provider;
    } else {
      this.provider = new OllamaProvider({
        baseUrl: opts.baseUrl ?? 'http://localhost:11434',
        model: opts.model ?? 'llama3.2',
      });
    }
    this.systemPromptOverride = opts.systemPrompt?.trim() || undefined;
  }

  async ask(question: string): Promise<QAResult> {
    // Step 1: extract keywords and search the graph
    const keywords = this.extractKeywords(question);
    const relevantNodes = [];

    for (const kw of keywords) {
      const found = await this.store.search(kw);
      relevantNodes.push(...found);
    }

    // Deduplicate
    const seen = new Set<string>();
    const unique = relevantNodes.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    }).slice(0, 20);

    // Step 2: build context from graph
    const contextParts: string[] = [];
    const contextRefs: QAResult['context'] = [];

    for (const node of unique) {
      const meta = JSON.parse(node.metadata || '{}');
      contextParts.push(
        `[${node.kind}] ${node.qualifiedName}\n` +
        `  Description: ${node.description}\n` +
        `  File: ${node.filePath}:${node.startLine}-${node.endLine}\n` +
        `  Details: ${JSON.stringify(meta)}`
      );
      contextRefs.push({
        nodeId: node.id,
        name: node.qualifiedName,
        kind: node.kind,
        relevance: 'keyword match',
      });
    }

    // Also get graph stats for overview questions
    const stats = await this.store.getStats();
    contextParts.push(`\nCodebase Statistics: ${JSON.stringify(stats)}`);

    // Get architecture patterns
    const patterns = await this.store.getNodesByKind('ArchPattern');
    if (patterns.length > 0) {
      contextParts.push(
        `\nDetected Architecture Patterns: ${patterns.map(p => p.name).join(', ')}`
      );
    }

    const context = contextParts.join('\n\n');

    // Step 3: try the LLM provider, fall back to graph-only
    const systemPrompt = this.buildSystemPrompt(context);

    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ];
      const answer = await this.provider.chat(messages);
      return { answer, context: contextRefs, model: this.provider.model, fallback: false };
    } catch {
      // Fallback: construct answer from graph data
      const answer = this.buildGraphOnlyAnswer(question, unique, stats, patterns);
      return { answer, context: contextRefs, model: 'graph-only', fallback: true };
    }
  }

  /**
   * Ask a question using the agentic engine (iterative tool-using loop).
   *
   * This is the Phase 2 agentic path. If the provider supports tool-calling,
   * the agent will query the graph, read files, and run impact analysis
   * iteratively before answering. If the provider does not support tools,
   * it falls back to the single-shot `ask()` method.
   *
   * Returns a result compatible with {@link QAResult} so callers can use
   * either method interchangeably.
   */
  async askAgentic(
    question: string,
    opts?: { repoRoot?: string; maxIterations?: number },
  ): Promise<QAResult> {
    // If the provider doesn't support tools, fall back to single-shot
    if (!isToolCapable(this.provider)) {
      return this.ask(question);
    }

    const repoRoot = opts?.repoRoot ?? process.cwd();
    const engine = new AgentEngine({
      provider: this.provider,
      toolContext: { store: this.store, repoRoot },
      maxIterations: opts?.maxIterations ?? 15,
      systemPromptOverride: this.systemPromptOverride,
    });

    let result: AgentTurnResult | null = null;
    for await (const event of engine.run(question)) {
      // Consume events — in this non-streaming context we just need the final result
      if (event.type === 'turn_end' as any) {
        result = {
          answer: (event as any).answer,
          iterations: (event as any).iterations,
          toolCallsMade: (event as any).toolCallsMade,
          fallback: (event as any).fallback,
          messages: [],
        };
      }
    }

    if (!result) {
      return { answer: 'No response from agent.', context: [], model: this.provider.model, fallback: true };
    }

    return {
      answer: result.answer,
      context: [],
      model: this.provider.model,
      fallback: result.fallback,
    };
  }

  /**
   * Build the system prompt. Uses the override (from env/constructor) if set,
   * otherwise falls back to {@link DEFAULT_SYSTEM_PROMPT}. If the template
   * contains the `{context}` placeholder, the graph context is substituted
   * there; otherwise it is appended at the end.
   */
  private buildSystemPrompt(context: string): string {
    const template = this.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
    if (template.includes('{context}')) {
      return template.replaceAll('{context}', context);
    }
    return `${template}\n\n${context}`;
  }

  private extractKeywords(question: string): string[] {
    const stopWords = new Set([
      'what', 'is', 'the', 'a', 'an', 'how', 'does', 'do', 'this', 'that',
      'in', 'for', 'of', 'to', 'and', 'or', 'it', 'be', 'are', 'was', 'were',
      'can', 'could', 'would', 'should', 'will', 'about', 'which', 'where',
      'who', 'when', 'why', 'my', 'me', 'i', 'you', 'your', 'tell', 'show',
      'find', 'get', 'with', 'from', 'use', 'used', 'using',
    ]);

    return question
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  private buildGraphOnlyAnswer(
    question: string,
    nodes: any[],
    stats: Record<string, number>,
    patterns: any[],
  ): string {
    const lines: string[] = [];

    lines.push(`*(${this.provider.name} not available — showing graph-based answer)*\n`);

    if (nodes.length === 0) {
      lines.push('No matching entities found in the knowledge graph for your query.');
      lines.push(`\nThe codebase contains: ${Object.entries(stats).map(([k, v]) => `${v} ${k}(s)`).join(', ')}`);
    } else {
      lines.push(`Found ${nodes.length} relevant entities:\n`);
      for (const node of nodes.slice(0, 10)) {
        lines.push(`• **${node.kind}**: \`${node.qualifiedName}\``);
        lines.push(`  ${node.description}`);
        lines.push(`  📁 ${node.filePath}:${node.startLine}`);
      }
    }

    if (patterns.length > 0) {
      lines.push(`\n**Architectural Patterns:** ${patterns.map((p: any) => p.name).join(', ')}`);
    }

    return lines.join('\n');
  }
}
