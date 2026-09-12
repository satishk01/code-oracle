/**
 * Retry utility unit tests.
 *
 * Covers classifyError, isRetriable, friendlyErrorMessage, and withRetry
 * (retriable vs non-retriable, backoff, max attempts).
 */
import { describe, it, expect, vi } from 'vitest';
import { classifyError, isRetriable, friendlyErrorMessage, withRetry } from '../retry.js';

function errWith(message: string, status?: number): Error {
  const e = new Error(message);
  if (status !== undefined) (e as any).status = status;
  return e;
}

describe('classifyError', () => {
  it('classifies auth errors (401 / api key / unauthorized)', () => {
    expect(classifyError(errWith('Unauthorized', 401))).toBe('auth');
    expect(classifyError(errWith('Invalid api key'))).toBe('auth');
    expect(classifyError(errWith('unauthorized access'))).toBe('auth');
  });

  it('classifies quota errors (402 / quota / billing)', () => {
    expect(classifyError(errWith('quota exceeded', 402))).toBe('quota');
    expect(classifyError(errWith('insufficient credits'))).toBe('quota');
    expect(classifyError(errWith('billing issue'))).toBe('quota');
  });

  it('classifies rate-limit errors (429)', () => {
    expect(classifyError(errWith('Too many requests', 429))).toBe('rate_limit');
    expect(classifyError(errWith('rate limit hit'))).toBe('rate_limit');
  });

  it('classifies network errors', () => {
    expect(classifyError(errWith('fetch failed'))).toBe('network');
    expect(classifyError(errWith('ECONNREFUSED'))).toBe('network');
    expect(classifyError(errWith('request timeout'))).toBe('network');
  });

  it('classifies server errors (5xx)', () => {
    expect(classifyError(errWith('boom', 500))).toBe('server');
    expect(classifyError(errWith('bad gateway', 502))).toBe('server');
  });

  it('falls back to unknown for anything else', () => {
    expect(classifyError(errWith('something weird'))).toBe('unknown');
    expect(classifyError(errWith('not found', 404))).toBe('unknown');
  });
});

describe('isRetriable', () => {
  it('retries rate_limit, network, and server', () => {
    expect(isRetriable('rate_limit')).toBe(true);
    expect(isRetriable('network')).toBe(true);
    expect(isRetriable('server')).toBe(true);
  });

  it('does not retry auth, quota, or unknown', () => {
    expect(isRetriable('auth')).toBe(false);
    expect(isRetriable('quota')).toBe(false);
    expect(isRetriable('unknown')).toBe(false);
  });
});

describe('friendlyErrorMessage', () => {
  it('mentions API key for auth errors', () => {
    const msg = friendlyErrorMessage(errWith('Unauthorized'));
    expect(msg.toLowerCase()).toContain('api key');
  });

  it('mentions network for network errors', () => {
    const msg = friendlyErrorMessage(errWith('fetch failed'));
    expect(msg.toLowerCase()).toContain('network');
  });

  it('passes through unknown errors', () => {
    const msg = friendlyErrorMessage(errWith('weird thing'));
    expect(msg).toContain('weird thing');
  });
});

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retriable errors up to maxRetries then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw errWith('fetch failed'); // network → retriable
      return 'recovered';
    });

    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 1, jitter: 0 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately for non-retriable (auth) errors', async () => {
    const fn = vi.fn().mockRejectedValue(errWith('Unauthorized', 401));
    await expect(withRetry(fn, { maxRetries: 3, initialDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries on persistent retriable errors', async () => {
    const fn = vi.fn().mockRejectedValue(errWith('server boom', 500));
    await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 1, jitter: 0 })).rejects.toThrow();
    // attempt 0, retry 1, retry 2 => 3 calls total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps the final error in a friendly message', async () => {
    const fn = vi.fn().mockRejectedValue(errWith('fetch failed'));
    await expect(withRetry(fn, { maxRetries: 1, initialDelayMs: 1, jitter: 0 })).rejects.toThrow(
      /network/i,
    );
  });
});
