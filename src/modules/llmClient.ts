/**
 * Minimal OpenAI-compatible chat completions client.
 * Uses `fetch`, which is available in the plugin chrome sandbox.
 */

import { createAbortController } from "../utils/globals";

export interface ChatCompletionOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 1500;

/** Error for a response-level failure; `retryable` is explicit. */
class LLMError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Fetch-level network failure, which is retried once. */
class LLMNetworkError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractContent(data: unknown): string {
  if (!isObject(data)) {
    return "";
  }
  const choices = data.choices;
  if (!Array.isArray(choices) || !isObject(choices[0])) {
    return "";
  }
  const message = choices[0].message;
  const content = isObject(message) ? message.content : undefined;
  if (typeof content === "string") {
    return content;
  }
  // Some providers return an array of content parts.
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isObject(part) && typeof part.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

function isRetriable(err: unknown): boolean {
  return (
    err instanceof LLMNetworkError || (err instanceof LLMError && err.retryable)
  );
}

export async function chatCompletion(
  opts: ChatCompletionOptions,
): Promise<string> {
  const url = `${opts.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const attempt = async (): Promise<string> => {
    const controller = createAbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (opts.signal?.aborted) {
      controller.abort();
    } else {
      opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            temperature: 0.3,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) {
          throw new LLMError("LLM request timed out");
        }
        if (opts.signal?.aborted) {
          throw new LLMError("LLM request cancelled");
        }
        throw new LLMNetworkError(
          err instanceof Error ? err.message : String(err),
        );
      }

      if (!res.ok) {
        const body = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        throw new LLMError(
          `LLM request failed: ${res.status} ${body.slice(0, 200)}`,
          res.status,
          retryable,
        );
      }

      const content = extractContent(await res.json()).trim();
      if (!content) {
        throw new LLMError("LLM returned empty content");
      }
      return content;
    } catch (err) {
      if (timedOut) {
        throw new LLMError("LLM request timed out");
      }
      if (opts.signal?.aborted) {
        throw new LLMError("LLM request cancelled");
      }
      if (err instanceof TypeError) {
        throw new LLMNetworkError(err.message);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (i === 1 || !isRetriable(err)) {
        throw err;
      }
      await Zotero.Promise.delay(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export interface ConnectionTestResult {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
}

/**
 * Probe the configured chat-completions endpoint with a tiny request.
 * Never throws; failures come back as `error` text suitable for display.
 */
export async function testChatConnection(
  cfg: { baseURL: string; apiKey: string; model: string },
  timeoutMs = 20_000,
): Promise<ConnectionTestResult> {
  const started = Date.now();
  try {
    const reply = await chatCompletion({
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.model,
      system: "You are a connectivity probe.",
      user: "Reply with a short greeting to confirm the connection works.",
      timeoutMs,
    });
    return { ok: true, ms: Date.now() - started, reply };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
