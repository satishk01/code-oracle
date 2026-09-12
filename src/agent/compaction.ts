/**
 * Context Compaction
 *
 * When conversation history approaches the token budget, summarize older
 * turns (via a cheap LLM call) then trim. Emits a user-visible notice event.
 * Prevents silent truncation failures on long sessions.
 *
 * Inspired by OpenWorker's `coworker/compaction.py` — context compaction
 * with LLM summarization.
 */

import type { ChatMessage, LLMProvider } from '../llm/provider.js';
import { logger } from '../util/logger.js';

const log = logger.child('compaction');

/** Rough estimate of tokens per character (conservative). */
const CHARS_PER_TOKEN = 4;

/** Default token budget for conversation history. */
export const DEFAULT_TOKEN_BUDGET = 120000;

/** Compaction trigger — start compacting at 80% of budget. */
const COMPACTION_THRESHOLD = 0.8;

/** Minimum messages to keep un-compacted (recent context). */
const MIN_KEEP_RECENT = 6;

export interface CompactionResult {
  /** The compacted message list. */
  messages: ChatMessage[];
  /** Whether compaction was performed. */
  compacted: boolean;
  /** Number of messages removed. */
  messagesRemoved: number;
  /** Estimated tokens saved. */
  tokensSaved: number;
}

/**
 * Estimate the token count of a message list.
 * Uses a conservative char-based heuristic (no tokenizer dependency).
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += (msg.content ?? '').length;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function.name.length + tc.function.arguments.length);
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Compact the conversation history if it exceeds the token budget.
 *
 * Strategy:
 *  1. Keep the system message (index 0) and the last MIN_KEEP_RECENT messages.
 *  2. Summarize the middle messages (older turns) into a single compact message.
 *  3. If no LLM provider is available for summarization, just trim (keep recent).
 *
 * Returns the (possibly compacted) message list and metadata.
 */
export async function compactIfNeeded(
  messages: ChatMessage[],
  provider: LLMProvider,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): Promise<CompactionResult> {
  const estimatedTokens = estimateTokens(messages);
  const threshold = Math.floor(tokenBudget * COMPACTION_THRESHOLD);

  if (estimatedTokens < threshold) {
    return { messages, compacted: false, messagesRemoved: 0, tokensSaved: 0 };
  }

  log.info(`Compaction triggered: ${estimatedTokens} tokens > ${threshold} threshold`);

  // Keep system message + recent messages
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const recentStart = systemMsg ? 1 : 0;
  const recentMessages = messages.slice(-MIN_KEEP_RECENT);
  const olderMessages = messages.slice(recentStart, messages.length - MIN_KEEP_RECENT);

  if (olderMessages.length === 0) {
    return { messages, compacted: false, messagesRemoved: 0, tokensSaved: 0 };
  }

  // Try to summarize older messages via the LLM
  let summary: string;
  try {
    summary = await summarizeMessages(olderMessages, provider);
  } catch (err: any) {
    log.warn(`Summarization failed, falling back to trim`, { error: err.message });
    // Fallback: just keep the recent messages + system
    const trimmed = systemMsg
      ? [systemMsg, ...recentMessages]
      : [...recentMessages];
    const savedTokens = estimatedTokens - estimateTokens(trimmed);
    return {
      messages: trimmed,
      compacted: true,
      messagesRemoved: olderMessages.length,
      tokensSaved: savedTokens,
    };
  }

  // Build compacted message list
  const compactedMessages: ChatMessage[] = [];
  if (systemMsg) compactedMessages.push(systemMsg);

  // Insert the summary as a system message
  compactedMessages.push({
    role: 'system',
    content: `[Conversation Summary]\nEarlier in this conversation, the following interactions occurred:\n\n${summary}\n\n[End of Summary — recent messages follow]`,
  });

  compactedMessages.push(...recentMessages);

  const savedTokens = estimatedTokens - estimateTokens(compactedMessages);

  log.info(`Compaction complete: removed ${olderMessages.length} messages, saved ~${savedTokens} tokens`);

  return {
    messages: compactedMessages,
    compacted: true,
    messagesRemoved: olderMessages.length,
    tokensSaved: savedTokens,
  };
}

/**
 * Summarize a list of older messages into a concise summary using the LLM.
 */
async function summarizeMessages(messages: ChatMessage[], provider: LLMProvider): Promise<string> {
  const conversationText = messages.map(m => {
    const role = m.role.toUpperCase();
    let text = `[${role}]`;
    if (m.content) text += ` ${m.content}`;
    if (m.tool_calls) {
      text += ` [Tool calls: ${m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(', ')}]`;
    }
    return text;
  }).join('\n\n');

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a conversation summarizer. Summarize the following conversation history concisely, preserving key facts, tool results, and conclusions. Keep it under 500 words.',
    },
    {
      role: 'user',
      content: `Summarize this conversation:\n\n${conversationText.slice(0, 8000)}`,
    },
  ];

  return await provider.chat(summaryPrompt);
}
