/**
 * Retry with Backoff
 *
 * Retries provider errors with exponential backoff. Translates errors into
 * friendly messages (quota vs auth vs network). Guards on retriable error
 * tails to avoid retrying non-retriable failures.
 *
 * Inspired by OpenWorker's `TurnEngine.retry()` and
 * `coworker/providers/errors.py`.
 */

import { logger } from '../util/logger.js';

const log = logger.child('retry');

/** Error categories for friendly messaging. */
export type ErrorCategory = 'quota' | 'auth' | 'network' | 'rate_limit' | 'server' | 'unknown';

export interface RetryOptions {
  /** Max retry attempts (default: 3). */
  maxRetries?: number;
  /** Initial delay in ms (default: 1000). */
  initialDelayMs?: number;
  /** Max delay in ms (default: 10000). */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2). */
  multiplier?: number;
  /** Optional jitter factor 0-1 (default: 0.1). */
  jitter?: number;
}

/** Classify an error into a category for messaging and retry decisions. */
export function classifyError(err: any): ErrorCategory {
  const msg = (err?.message ?? String(err)).toLowerCase();
  const status = err?.status ?? err?.statusCode;

  if (status === 401 || msg.includes('unauthorized') || msg.includes('api key')) return 'auth';
  if (status === 402 || msg.includes('quota') || msg.includes('billing') || msg.includes('insufficient')) return 'quota';
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) return 'rate_limit';
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('network')) return 'network';
  if (status && status >= 500) return 'server';
  return 'unknown';
}

/** Translate an error into a user-friendly message. */
export function friendlyErrorMessage(err: any): string {
  const category = classifyError(err);
  const original = err?.message ?? String(err);

  switch (category) {
    case 'auth':
      return `Authentication failed. Check your API key in .env (OMNIROUTE_API_KEY or OLLAMA settings). Original: ${original}`;
    case 'quota':
      return `Quota or billing limit reached. Check your provider account. Original: ${original}`;
    case 'rate_limit':
      return `Rate limit exceeded. The agent will retry automatically. Original: ${original}`;
    case 'network':
      return `Network error — could not reach the LLM provider. Is the server running? Original: ${original}`;
    case 'server':
      return `Server error from the LLM provider. Original: ${original}`;
    default:
      return original;
  }
}

/** Whether an error category is worth retrying. */
export function isRetriable(category: ErrorCategory): boolean {
  return category === 'rate_limit' || category === 'network' || category === 'server';
}

/**
 * Execute a function with retry and exponential backoff.
 * Only retries retriable errors (rate_limit, network, server).
 * Non-retriable errors (auth, quota, unknown) throw immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const initialDelay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 10000;
  const multiplier = opts.multiplier ?? 2;
  const jitter = opts.jitter ?? 0.1;

  let lastErr: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const category = classifyError(err);

      if (!isRetriable(category) || attempt === maxRetries) {
        throw new Error(friendlyErrorMessage(err));
      }

      // Calculate delay with exponential backoff + jitter
      const baseDelay = Math.min(initialDelay * Math.pow(multiplier, attempt), maxDelay);
      const jitterAmount = baseDelay * jitter * (Math.random() * 2 - 1);
      const delay = Math.max(0, baseDelay + jitterAmount);

      log.warn(`Retrying after ${delay.toFixed(0)}ms (attempt ${attempt + 1}/${maxRetries})`, {
        category,
        error: err.message,
      });

      await sleep(delay);
    }
  }

  throw new Error(friendlyErrorMessage(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
