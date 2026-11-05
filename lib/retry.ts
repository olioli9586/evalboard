import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Retry for a single API call: exponential backoff with full jitter on 429,
// 5xx and dropped connections, honoring the API's retry-after. The worker's
// client is built with maxRetries: 0, so this is the only retry layer and
// every attempt is counted on the result row.
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts: number; // total tries, the first one included
  baseDelayMs: number;
  // Longest single wait. A retry-after above this gives up instead: sleeping
  // that long inside a 300 s function is worse than handing the batch back to
  // the queue, which can wait for free.
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const NO_RETRY: RetryOptions = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
export const WORKER_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 20_000 };

// The SDK's rules, but for timeouts: an explicit x-should-retry header wins,
// then 408, 409, 429 and any 5xx (529 "overloaded" included), and dropped
// connections. A timeout is not retried: the call ran for the client's whole
// timeout, most likely because the answer is that long, so another try would
// take as long, cost as much, and could outlast the function.
export function isRetryable(err: unknown): boolean {
  if (err instanceof APIConnectionTimeoutError) return false;
  if (err instanceof APIConnectionError) return true;
  if (!(err instanceof APIError) || err.status === undefined) return false;
  const hint = err.headers?.get("x-should-retry");
  if (hint === "true") return true;
  if (hint === "false") return false;
  return err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
}

// The wait the API asked for, if any: retry-after-ms, then retry-after as
// seconds or as an HTTP date.
export function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof APIError) || !err.headers) return undefined;
  const ms = Number.parseFloat(err.headers.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const raw = err.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// Full jitter: a random wait between 0 and the exponential ceiling. Many
// workers hitting the same rate limit then spread out instead of retrying in
// lockstep and colliding again.
export function backoffMs(failedAttempt: number, opts: RetryOptions, random = Math.random): number {
  return random() * Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (failedAttempt - 1));
}

// Runs fn until it succeeds, fails with a non-retryable error, or runs out of
// attempts; the last error is rethrown. `tally` counts every attempt, so one
// tally shared across a case's model and judge calls gives its total.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  tally: { attempts: number } = { attempts: 0 },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    tally.attempts++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts || !isRetryable(err)) throw err;
      const hinted = retryAfterMs(err);
      if (hinted !== undefined && hinted > opts.maxDelayMs) throw err;
      await sleep(hinted ?? backoffMs(attempt, opts, opts.random));
    }
  }
}
