/**
 * LLM driver — one OpenAI-compatible client, vendor chosen by base URL.
 *
 * Same arrangement as tapify-voice-agent: Groq, OpenAI, Together, OpenRouter
 * and a local Ollama all speak /chat/completions, so switching vendor is an
 * .env change, not a code change. Default is Groq, per the locked decision.
 *
 * Content generation (Phase 2) is where this gets used in anger. It lands in
 * Phase 0 so the key is proven working before anything depends on it.
 */

import { env } from '../config.ts';
import { log } from '../util/log.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object back. Supported by Groq's OpenAI-compatible API. */
  json?: boolean;
  timeoutMs?: number;
  retries?: number;
}

/**
 * Reasoning models (Groq's gpt-oss, qwen3, and friends) spend tokens thinking
 * before they emit a single character of answer, and that thinking comes out of
 * the same `max_tokens` budget. A 10-token request returns `finish_reason:
 * "length"` with an EMPTY content string and all ten tokens in
 * `reasoning_tokens` — which looks exactly like "the model said nothing".
 *
 * So every request gets a floor, whatever the caller asked for.
 */
const MIN_TOKENS = 512;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function requireKey(): string {
  const key = env.llm.apiKey;
  if (!key) {
    throw new LlmError(
      'LLM_API_KEY is not set. Put the Groq key (gsk_...) in .env as LLM_API_KEY.\n' +
        'The same key the voice agent uses works here.',
    );
  }
  return key;
}

/** One chat completion, with retry on 429 and 5xx. */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const key = requireKey();
  const model = opts.model ?? env.llm.model;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: Math.max(opts.maxTokens ?? env.llm.maxTokens, MIN_TOKENS),
          temperature: opts.temperature ?? 0.7,
          // Only sent when explicitly configured: an OpenAI-compatible endpoint
          // that does not know this parameter answers 400.
          ...(env.llm.reasoningEffort ? { reasoning_effort: env.llm.reasoningEffort } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 429 and 5xx are worth another try; 400/401/404 are not — a wrong key
        // or a retired model name will fail identically forever.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
          log.warn(`LLM ${res.status}; retrying in ${wait}ms`);
          await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
          continue;
        }
        // The vendor's own explanation is the only useful part of a 4xx, so it
        // goes in the message rather than a field nobody prints.
        let detail = body.slice(0, 400);
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          /* not JSON; the raw body will do */
        }

        throw new LlmError(
          res.status === 404
            ? `Model "${model}" was rejected (404). Vendors retire model names — set LLM_MODEL to a current one.`
            : `LLM request failed: ${res.status} — ${detail}`,
          res.status,
          body.slice(0, 600),
        );
      }

      const json = (await res.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning?: string };
        }>;
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
      };

      const choice = json.choices?.[0];
      const text = choice?.message?.content;

      if (!text) {
        const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
        if (choice?.finish_reason === 'length') {
          throw new LlmError(
            `"${model}" ran out of tokens before answering` +
              (reasoningTokens ? ` — it spent ${reasoningTokens} of them reasoning` : '') +
              '. Raise LLM_MAX_TOKENS in .env, or set LLM_REASONING_EFFORT=low.',
          );
        }
        throw new LlmError(
          `"${model}" returned an empty answer (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`,
        );
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (err instanceof LlmError && err.status && err.status < 500 && err.status !== 429) throw err;
      if (attempt === retries) break;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

/**
 * Parses a JSON reply, tolerating a model that wraps it in a code fence.
 *
 * Retries once with double the budget on a specific, well-understood failure:
 * Groq answers 400 "Failed to validate JSON" when the model runs out of tokens
 * part-way through the object. With a reasoning model the thinking comes out of
 * the same budget, so a request that is comfortable for a plain model truncates
 * for this one. Doubling and retrying costs one call and fixes it; the
 * alternative is a scheduled run that drops an article a day for no visible
 * reason.
 */
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
  let raw: string;
  try {
    raw = await chat(messages, { ...opts, json: true });
  } catch (err) {
    const truncated =
      err instanceof LlmError && err.status === 400 && /validate JSON|failed_generation/i.test(err.message);
    if (!truncated) throw err;

    const bigger = Math.max((opts.maxTokens ?? env.llm.maxTokens) * 2, 4096);
    log.warn(`the model truncated its JSON; retrying once with ${bigger} tokens`);
    raw = await chat(messages, { ...opts, json: true, maxTokens: bigger });
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new LlmError(`LLM did not return valid JSON. First 300 chars: ${cleaned.slice(0, 300)}`);
  }
}

/** Connectivity check for `npm run llm:ping`. */
export async function ping(): Promise<string> {
  // Deliberately generous: a reasoning model needs room to think before it can
  // say "ok", and a ping that fails for lack of budget teaches nothing.
  const reply = await chat(
    [
      { role: 'system', content: 'Reply with exactly: ok' },
      { role: 'user', content: 'ping' },
    ],
    { maxTokens: 512, temperature: 0 },
  );
  return reply.trim();
}
