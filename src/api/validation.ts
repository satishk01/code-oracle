/**
 * Zod input-validation schemas for the Express API.
 *
 * Every POST/PUT/DELETE endpoint that accepts a JSON request body validates
 * against one of these schemas before any business logic runs. On validation
 * failure the server responds with HTTP 400 and the first issue message.
 *
 * Schemas are intentionally permissive about extra keys (Zod's default
 * `.strip()` behaviour) so adding new optional fields to a request body does
 * not break older clients. Required fields are enforced with meaningful
 * constraints (e.g. non-empty strings).
 */

import { z } from 'zod';

// ── /api/ask & /api/ask/stream ─────────────────────────────────────

/** Body for the Q&A endpoints. */
export const askSchema = z.object({
  question: z.string().min(1, 'Question must not be empty'),
});

// ── /api/repo (POST) ───────────────────────────────────────────────

/** Body for switching the active repo. */
export const setRepoSchema = z.object({
  repoRoot: z.string().min(1, 'repoRoot must not be empty'),
});

// ── /api/ingest ────────────────────────────────────────────────────

/** Body for triggering full/incremental ingestion. */
export const ingestSchema = z.object({
  incremental: z.boolean().optional(),
  full: z.boolean().optional(),
  repoRoot: z.string().optional(),
  useLlmEnrichment: z.boolean().optional(),
});

// ── /api/impact ────────────────────────────────────────────────────

/** A single changed-file entry. */
export const changeItemSchema = z.object({
  filePath: z.string().min(1, 'filePath must not be empty'),
  type: z.enum(['modified', 'added', 'deleted'], {
    errorMap: () => ({ message: "type must be 'modified', 'added', or 'deleted'" }),
  }),
});

/** Body for impact analysis. */
export const impactSchema = z.object({
  changes: z.array(changeItemSchema).min(1, 'changes must be a non-empty array'),
  useLlm: z.boolean().optional(),
});

// ── /api/requirement-impact ────────────────────────────────────────

/** Body for requirement-based impact analysis. */
export const requirementImpactSchema = z.object({
  requirement: z.string().min(1, 'requirement must not be empty'),
  useLlm: z.boolean().optional(),
});

// ── /api/repos (DELETE) ────────────────────────────────────────────

/** Body for removing a repo from the registry. */
export const removeRepoSchema = z.object({
  repoRoot: z.string().min(1, 'repoRoot must not be empty'),
  deleteData: z.boolean().optional(),
});

// ── /api/permission/resolve ────────────────────────────────────────

/** Body for resolving a pending permission request. */
export const permissionResolveSchema = z.object({
  engineId: z.string().min(1, 'engineId must not be empty'),
  toolCallId: z.string().min(1, 'toolCallId must not be empty'),
  decision: z.enum(['approved', 'denied'], {
    errorMap: () => ({ message: "decision must be 'approved' or 'denied'" }),
  }),
  reason: z.string().optional(),
});

// ── /api/permission/mode ───────────────────────────────────────────

/** Body for setting the permission mode. */
export const permissionModeSchema = z.object({
  mode: z.enum(['discuss', 'plan', 'interactive', 'auto-approve', 'bypass'], {
    errorMap: () => ({
      message:
        "Invalid mode. Valid: discuss, plan, interactive, auto-approve, bypass",
    }),
  }),
});

// ── /api/memory (POST) ─────────────────────────────────────────────

/** Body for adding a memory item. */
export const addMemorySchema = z.object({
  content: z.string().min(1, 'content must not be empty'),
  scope: z.enum(['global', 'workspace', 'session']).optional(),
  tags: z.array(z.string()).optional(),
});

// ── /api/memory (DELETE) ───────────────────────────────────────────

/** Body for clearing memory items. */
export const clearMemorySchema = z.object({
  scope: z.enum(['global', 'workspace', 'session']).optional(),
});

// ── /api/cypher ────────────────────────────────────────────────────

/**
 * Destructive Cypher keywords that must never be run via the public API.
 * Checked case-insensitively against the parsed query.
 */
const DESTRUCTIVE_CYPHER_KEYWORDS = [
  'DROP',
  'DELETE',
  'REMOVE',
  'CREATE TABLE',
  'ALTER',
];

/** Body for the raw Cypher endpoint. Rejects destructive queries. */
export const cypherSchema = z
  .object({
    query: z.string().min(1, 'query must not be empty'),
    params: z.record(z.any()).optional(),
  })
  .superRefine((val, ctx) => {
    const upper = val.query.toUpperCase();
    for (const kw of DESTRUCTIVE_CYPHER_KEYWORDS) {
      if (upper.includes(kw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Destructive Cypher keyword "${kw}" is not allowed`,
        });
        return;
      }
    }
  });
