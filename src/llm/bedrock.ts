/**
 * AWS Bedrock LLM Provider
 *
 * Uses the Bedrock OpenAI-compatible endpoint
 * (`/openai/v1/chat/completions`) so the same request/response format and
 * SSE stream parser as the other providers can be reused.
 *
 * Four authentication modes are supported:
 *
 *  1. `iam-long-term`   — Access key + secret access key + region
 *  2. `iam-short-term`  — Access key + secret access key + region + session token
 *  3. `api-key`         — Bedrock API key + region (endpoint derived from region)
 *  4. `api-key-endpoint`— Bedrock API key + region + explicit API endpoint
 *
 * IAM modes sign every request with AWS Signature V4 (HMAC-SHA256).
 * API-key modes send a `Bearer` token (no signing required).
 */

import crypto from 'crypto';
import type { OpenAITool } from '../agent/tools/registry.js';
import type {
  ChatMessage,
  LLMProvider,
  StreamDelta,
  ToolCapableProvider,
} from './provider.js';
import { parseOpenAISSE } from './provider.js';

/** How the provider authenticates with Bedrock. */
export type BedrockAuthMethod =
  | 'iam-long-term'
  | 'iam-short-term'
  | 'api-key'
  | 'api-key-endpoint';

export interface BedrockProviderOptions {
  /** AWS region, e.g. "us-east-1". */
  region: string;
  /** Bedrock model identifier, e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0". */
  model: string;
  /** Authentication method. */
  authMethod: BedrockAuthMethod;
  /** AWS access key ID (IAM modes). */
  accessKeyId?: string;
  /** AWS secret access key (IAM modes). */
  secretAccessKey?: string;
  /** AWS session token (iam-short-term mode). */
  sessionToken?: string;
  /** Bedrock API key (api-key / api-key-endpoint modes). */
  apiKey?: string;
  /**
   * Explicit API endpoint base URL (api-key-endpoint mode).
   * If omitted in api-key mode, it is derived from the region.
   */
  endpoint?: string;
}

// ── AWS Signature V4 ────────────────────────────────────────────────

const BEDROCK_SERVICE = 'bedrock';
const SIG_ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');

/**
 * Sign a request with AWS Signature V4 and return the headers to attach.
 * Implements the standard SigV4 signing process for a POST request with
 * a JSON body against the Bedrock service.
 */
function sigV4Sign(params: {
  method: string;
  url: URL;
  body: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Record<string, string> {
  const { method, url, body, region, accessKeyId, secretAccessKey, sessionToken } = params;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const host = url.host;
  const path = url.pathname;
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');

  // Canonical headers must be sorted alphabetically by header name (lowercase).
  const headerEntries: [string, string][] = [
    ['host', host],
    ['x-amz-date', amzDate],
  ];
  if (sessionToken) {
    headerEntries.push(['x-amz-security-token', sessionToken]);
  }
  headerEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders =
    headerEntries.map(([k, v]) => `${k}:${v.trim()}\n`).join('');
  const signedHeaders = headerEntries.map(([k]) => k).join(';');

  // Canonical request
  const canonicalRequest = [
    method,
    path,
    url.search.replace(/^\?/, ''), // query string (empty for POST)
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${BEDROCK_SERVICE}/aws4_request`;
  const stringToSign = [
    SIG_ALGORITHM,
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // Signing key: derived through iterative HMAC
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, BEDROCK_SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization =
    `${SIG_ALGORITHM} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-amz-date': amzDate,
    Authorization: authorization,
  };
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }
  return headers;
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// ── BedrockProvider ─────────────────────────────────────────────────

export class BedrockProvider implements ToolCapableProvider {
  readonly name = 'bedrock';
  readonly model: string;
  readonly supportsTools = true;

  private region: string;
  private authMethod: BedrockAuthMethod;
  private accessKeyId?: string;
  private secretAccessKey?: string;
  private sessionToken?: string;
  private apiKey?: string;
  private baseUrl: string;
  /** Path appended to baseUrl for chat completions. */
  private chatPath: string;

  constructor(opts: BedrockProviderOptions) {
    this.region = opts.region;
    this.model = opts.model;
    this.authMethod = opts.authMethod;
    this.accessKeyId = opts.accessKeyId?.trim() || undefined;
    this.secretAccessKey = opts.secretAccessKey?.trim() || undefined;
    this.sessionToken = opts.sessionToken?.trim() || undefined;
    this.apiKey = opts.apiKey?.trim() || undefined;

    // Resolve the base URL and chat completions path.
    //
    // When a custom endpoint is provided (api-key-endpoint mode), it typically
    // already includes the API version prefix (e.g. a LiteLLM proxy at
    // "http://host/v1" or an AWS Bedrock endpoint at
    // "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"). In that
    // case we append just "/chat/completions".
    //
    // When no custom endpoint is provided, we use the default AWS Bedrock
    // runtime endpoint which requires the full "/openai/v1/chat/completions"
    // path.
    if (opts.endpoint && opts.endpoint.trim().length > 0) {
      this.baseUrl = opts.endpoint.replace(/\/$/, '');
      this.chatPath = '/chat/completions';
    } else {
      this.baseUrl = `https://bedrock-runtime.${this.region}.amazonaws.com`;
      this.chatPath = '/openai/v1/chat/completions';
    }

    this.validate();
  }

  /** Validate that the required credentials for the chosen auth method are present. */
  private validate(): void {
    switch (this.authMethod) {
      case 'iam-long-term':
        if (!this.accessKeyId || !this.secretAccessKey) {
          throw new Error(
            'Bedrock iam-long-term requires BEDROCK_ACCESS_KEY_ID and ' +
              'BEDROCK_SECRET_ACCESS_KEY. Set them in your .env.',
          );
        }
        break;
      case 'iam-short-term':
        if (!this.accessKeyId || !this.secretAccessKey || !this.sessionToken) {
          throw new Error(
            'Bedrock iam-short-term requires BEDROCK_ACCESS_KEY_ID, ' +
              'BEDROCK_SECRET_ACCESS_KEY, and BEDROCK_SESSION_TOKEN. ' +
              'Set them in your .env.',
          );
        }
        break;
      case 'api-key':
        if (!this.apiKey) {
          throw new Error(
            'Bedrock api-key requires BEDROCK_API_KEY. Set it in your .env.',
          );
        }
        break;
      case 'api-key-endpoint':
        if (!this.apiKey) {
          throw new Error(
            'Bedrock api-key-endpoint requires BEDROCK_API_KEY and ' +
              'BEDROCK_ENDPOINT. Set them in your .env.',
          );
        }
        break;
    }
  }

  /** Build the auth headers for a request body. */
  private buildHeaders(body: string, path: string): Record<string, string> {
    switch (this.authMethod) {
      case 'iam-long-term':
      case 'iam-short-term': {
        const url = new URL(`${this.baseUrl}${path}`);
        return sigV4Sign({
          method: 'POST',
          url,
          body,
          region: this.region,
          accessKeyId: this.accessKeyId!,
          secretAccessKey: this.secretAccessKey!,
          sessionToken: this.sessionToken,
        });
      }
      case 'api-key':
      case 'api-key-endpoint': {
        return {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        };
      }
    }
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: false,
    });
    const path = this.chatPath;
    const headers = this.buildHeaders(body, path);

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Bedrock returned ${resp.status} (Unauthorized). Check your ` +
            `${this.authMethod} credentials in .env. Response body: ${text}`,
        );
      }
      throw new Error(`Bedrock returned ${resp.status}: ${text}`);
    }
    const data = (await resp.json()) as any;
    return data.choices?.[0]?.message?.content ?? 'No response from model.';
  }

  async *chatWithTools(
    messages: ChatMessage[],
    tools: OpenAITool[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const bodyObj: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools.length > 0) bodyObj.tools = tools;
    const body = JSON.stringify(bodyObj);

    const path = this.chatPath;
    const headers = this.buildHeaders(body, path);

    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (!resp.ok || !resp.body) {
      const text = resp.ok ? '' : await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Bedrock returned ${resp.status} (Unauthorized). Check your ` +
            `${this.authMethod} credentials in .env. Response body: ${text}`,
        );
      }
      throw new Error(`Bedrock returned ${resp.status}: ${text}`);
    }
    yield* parseOpenAISSE(resp.body, signal);
  }
}
