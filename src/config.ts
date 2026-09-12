/**
 * Centralized configuration.
 *
 * Loads variables from a `.env` file at the project root (if present) and
 * exposes them as typed values. Environment variables always override `.env`.
 *
 * Copy `.env.example` to `.env` and edit values as needed.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import type { BedrockAuthMethod } from './llm/bedrock.js';

// Load .env from the project root (the directory containing package.json).
// Walk up from this file to find it so the config works whether invoked via
// `tsx src/...` or `node dist/...`.
function findEnvPath(): string | null {
  let dir = import.meta.dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envPath = findEnvPath();
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  // Still call dotenv.config() so any vars already in the process environment
  // are respected; this is a no-op if no .env exists.
  dotenv.config();
}

export type LLMProviderType = 'ollama' | 'omniroute' | 'bedrock';

export interface AppConfig {
  /** Repository root to analyze. */
  repoRoot: string;
  /** Port the API server listens on. */
  port: number;
  /** Which LLM provider to use for Q&A: "ollama", "omniroute", or "bedrock". */
  llmProvider: LLMProviderType;
  /** Ollama server base URL (e.g. http://localhost:11434). */
  ollamaUrl: string;
  /** Ollama model name (e.g. llama3.2, qwen2.5-coder:7b). */
  ollamaModel: string;
  /** Omniroute server base URL (e.g. http://localhost:20128). */
  omnirouteUrl: string;
  /** Omniroute model name (any model in the Omniroute catalog). */
  omnirouteModel: string;
  /** Omniroute API key (Bearer token). Optional for local unauthenticated setups. */
  omnirouteApiKey: string | undefined;
  /** AWS region for Bedrock (e.g. us-east-1). */
  bedrockRegion: string | undefined;
  /** Bedrock model identifier (e.g. anthropic.claude-3-5-sonnet-20241022-v2:0). */
  bedrockModel: string | undefined;
  /** Bedrock authentication method. */
  bedrockAuthMethod: BedrockAuthMethod | undefined;
  /** AWS access key ID (IAM auth modes). */
  bedrockAccessKeyId: string | undefined;
  /** AWS secret access key (IAM auth modes). */
  bedrockSecretAccessKey: string | undefined;
  /** AWS session token (iam-short-term mode). */
  bedrockSessionToken: string | undefined;
  /** Bedrock API key (api-key / api-key-endpoint modes). */
  bedrockApiKey: string | undefined;
  /** Explicit Bedrock API endpoint base URL (api-key-endpoint mode). */
  bedrockEndpoint: string | undefined;
  /** Optional override for the Q&A system prompt. */
  ollamaSystemPrompt: string | undefined;
  /** Log level for the structured logger: debug, info, warn, error, silent. */
  logLevel: string;
  /** Maximum agent loop iterations before forcing a stop. */
  agentMaxIterations: number;
  /** Agent permission mode: discuss, plan, interactive, auto-approve, bypass. */
  agentPermissionMode: string;
  /** Token budget for context compaction (default: 120000). */
  agentTokenBudget: number;
  /** Directory for app-level data: repo registry, pending-delete queue,
   *  global memory, ephemeral graph stores. Defaults to ./store under the
   *  working directory so deployments don't depend on a user home dir. */
  storeDir: string;
}

function requiredString(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

function requiredInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function llmProviderFromEnv(): LLMProviderType {
  const v = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (v === 'ollama' || v === 'omniroute' || v === 'bedrock') return v;
  return 'ollama';
}

function bedrockAuthMethodFromEnv(): BedrockAuthMethod | undefined {
  const v = process.env.BEDROCK_AUTH_METHOD?.trim().toLowerCase();
  if (
    v === 'iam-long-term' ||
    v === 'iam-short-term' ||
    v === 'api-key' ||
    v === 'api-key-endpoint'
  ) {
    return v;
  }
  return undefined;
}

export const config: AppConfig = {
  repoRoot: requiredString('REPO_ROOT', process.argv[2] || process.cwd()),
  port: requiredInt('PORT', 3001),
  llmProvider: llmProviderFromEnv(),
  ollamaUrl: requiredString('OLLAMA_URL', 'http://localhost:11434'),
  ollamaModel: requiredString('OLLAMA_MODEL', 'llama3.2'),
  omnirouteUrl: requiredString('OMNIROUTE_URL', 'http://localhost:20128'),
  omnirouteModel: requiredString('OMNIROUTE_MODEL', 'gpt-4o-mini'),
  omnirouteApiKey: process.env.OMNIROUTE_API_KEY?.trim() || undefined,
  bedrockRegion: process.env.BEDROCK_REGION?.trim() || undefined,
  bedrockModel: process.env.BEDROCK_MODEL?.trim() || undefined,
  bedrockAuthMethod: bedrockAuthMethodFromEnv(),
  bedrockAccessKeyId: process.env.BEDROCK_ACCESS_KEY_ID?.trim() || undefined,
  bedrockSecretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY?.trim() || undefined,
  bedrockSessionToken: process.env.BEDROCK_SESSION_TOKEN?.trim() || undefined,
  bedrockApiKey: process.env.BEDROCK_API_KEY?.trim() || undefined,
  bedrockEndpoint: process.env.BEDROCK_ENDPOINT?.trim() || undefined,
  ollamaSystemPrompt: process.env.OLLAMA_SYSTEM_PROMPT?.trim() || undefined,
  logLevel: requiredString('LOG_LEVEL', 'info'),
  agentMaxIterations: requiredInt('AGENT_MAX_ITERATIONS', 15),
  agentPermissionMode: requiredString('AGENT_PERMISSION_MODE', 'interactive'),
  agentTokenBudget: requiredInt('AGENT_TOKEN_BUDGET', 120000),
  storeDir: requiredString('STORE_DIR', path.join(process.cwd(), 'store')),
};
