#!/usr/bin/env node
/**
 * Codebase Oracle CLI
 *
 * Commands:
 *   ingest <repo-path>            — Parse and index a repository
 *   query <repo-path> <question>  — Ask a question about the codebase
 *   impact <repo-path> <files..>  — Analyze impact of changed files
 *   watch <repo-path>             — Watch for changes and report impact
 *   stats <repo-path>             — Show codebase statistics
 *   serve <repo-path>             — Start the API + dashboard server
 */

import { Command } from 'commander';
import { IngestEngine } from './parsers/ingest.js';
import { GraphStore } from './graph/store.js';
import { ImpactAnalyzer } from './analysis/impact.js';
import { RepoWatcher } from './analysis/watcher.js';
import { OllamaQA } from './llm/ollama.js';
import { createLLMProvider, createToolCapableProvider } from './llm/provider.js';
import { config } from './config.js';
import path from 'path';

const program = new Command();
program.name('codebase-oracle').version('1.0.0');

// ── ingest ───────────────────────────────────────────────────────
program
  .command('ingest [repo-path]')
  .description('Parse and index a repository into the knowledge graph')
  .option('--full', 'Force full re-ingestion (ignore cache)')
  .action(async (repoPath: string = '.', opts) => {
    const root = path.resolve(repoPath);
    console.log(`\n🔮 Ingesting: ${root}\n`);

    const engine = new IngestEngine({
      repoRoot: root,
      incremental: !opts.full,
    });
    const result = await engine.run();
    console.log(`\n✅ Done!`);
    console.log(`   Files processed: ${result.filesProcessed}`);
    console.log(`   Nodes created:   ${result.nodesCreated}`);
    console.log(`   Edges created:   ${result.edgesCreated}\n`);
  });

// ── stats ────────────────────────────────────────────────────────
program
  .command('stats [repo-path]')
  .description('Show codebase knowledge graph statistics')
  .action(async (repoPath: string = '.') => {
    const root = path.resolve(repoPath);
    const store = new GraphStore(root);
    await store.init();

    const stats = await store.getStats();
    const patterns = await store.getNodesByKind('ArchPattern');

    console.log('\n📊 Codebase Knowledge Graph Statistics\n');
    for (const [kind, count] of Object.entries(stats)) {
      console.log(`   ${kind.padEnd(15)} ${count}`);
    }

    if (patterns.length > 0) {
      console.log(`\n🏛  Detected Architecture Patterns:`);
      for (const p of patterns) {
        console.log(`   • ${p.name}`);
      }
    }

    await store.close();
    console.log();
  });

// ── query ────────────────────────────────────────────────────────
program
  .command('query [repo-path]')
  .description('Ask a question about the codebase')
  .argument('<question>', 'Your question')
  .option('--agentic', 'Use the agentic engine (iterative tool-using loop)')
  .action(async (repoPath: string = '.', question: string, opts: { agentic?: boolean }) => {
    const root = path.resolve(repoPath);
    const store = new GraphStore(root);
    await store.init();
    const provider = createToolCapableProvider({
      provider: config.llmProvider,
      ollamaUrl: config.ollamaUrl,
      ollamaModel: config.ollamaModel,
      omnirouteUrl: config.omnirouteUrl,
      omnirouteModel: config.omnirouteModel,
      omnirouteApiKey: config.omnirouteApiKey,
      bedrockRegion: config.bedrockRegion,
      bedrockModel: config.bedrockModel,
      bedrockAuthMethod: config.bedrockAuthMethod,
      bedrockAccessKeyId: config.bedrockAccessKeyId,
      bedrockSecretAccessKey: config.bedrockSecretAccessKey,
      bedrockSessionToken: config.bedrockSessionToken,
      bedrockApiKey: config.bedrockApiKey,
      bedrockEndpoint: config.bedrockEndpoint,
    });
    const qa = new OllamaQA(store, {
      provider,
      systemPrompt: config.ollamaSystemPrompt,
    });

    console.log(`\n❓ ${question}\n`);

    if (opts.agentic) {
      // Agentic path: iterative tool-using loop
      const { AgentEngine, EventType } = await import('./agent/index.js');
      const engine = new AgentEngine({
        provider,
        toolContext: { store, repoRoot: root },
        maxIterations: config.agentMaxIterations,
        systemPromptOverride: config.ollamaSystemPrompt,
      });

      let answer = '';
      let iterations = 0;
      let toolCalls = 0;
      for await (const event of engine.run(question)) {
        if (event.type === EventType.TOOL_PROPOSED) {
          const names = event.toolCalls.map(tc => tc.function.name).join(', ');
          console.log(`   🔧 Tool calls: ${names}`);
        } else if (event.type === EventType.TOOL_FINISHED) {
          const status = event.success ? '✓' : '✗';
          console.log(`   ${status} ${event.toolName} (${event.durationMs}ms)`);
          if (!event.success) console.log(`     Error: ${event.error}`);
          toolCalls++;
        } else if (event.type === EventType.TURN_END) {
          answer = event.answer;
          iterations = event.iterations;
        } else if (event.type === EventType.ERROR) {
          console.log(`   ⚠ ${event.message}`);
        } else if (event.type === EventType.MAX_ITERATIONS) {
          console.log(`   ⚠ Reached max iterations (${event.limit})`);
        }
      }

      console.log(answer);
      console.log(`\n(model: ${provider.model}, ${iterations} iterations, ${toolCalls} tool calls)\n`);
    } else {
      // Original single-shot path
      const result = await qa.ask(question);
      console.log(result.answer);
      console.log(`\n(model: ${result.model}, ${result.context.length} context nodes)\n`);
    }

    await store.close();
  });

// ── impact ───────────────────────────────────────────────────────
program
  .command('impact [repo-path]')
  .description('Analyze the impact of changed files')
  .argument('<files...>', 'Changed file paths (relative to repo root)')
  .action(async (repoPath: string = '.', files: string[]) => {
    const root = path.resolve(repoPath);
    const store = new GraphStore(root);
    await store.init();

    const analyzer = new ImpactAnalyzer(store);
    const report = await analyzer.analyzeChanges(
      files.map(f => ({ filePath: f, type: 'modified' as const }))
    );

    console.log(`\n${report.summary}\n`);
    await store.close();
  });

// ── watch ────────────────────────────────────────────────────────
program
  .command('watch [repo-path]')
  .description('Watch for file changes and report impact in real-time')
  .action(async (repoPath: string = '.') => {
    const root = path.resolve(repoPath);
    const store = new GraphStore(root);
    await store.init();
    const watcher = new RepoWatcher(root, store);

    watcher.onImpact((report) => {
      console.log(`\n${report.summary}\n`);
    });

    watcher.start();
    console.log('Press Ctrl+C to stop.\n');

    // Keep process alive
    await new Promise(() => {});
  });

program.parse();
