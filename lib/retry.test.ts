import { describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { backoffMs, isRetryable, retryAfterMs, withRetry, type RetryOptions } from "./retry";

function apiError(status: number, headers: Record<string, string> = {}) {
  return APIError.generate(status, { type: "error", error: { message: "x" } }, undefined, new Headers(headers));
}

// Waits are recorded instead of slept, and jitter is pinned to its ceiling.
function opts(overrides: Partial<RetryOptions> = {}) {
  const waits: number[] = [];
  const o: RetryOptions = {
    maxAttempts: 4,
    baseDelayMs: 1000,
    maxDelayMs: 20_000,
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 1,
    ...overrides,
  };
  return { o, waits };
}

describe("isRetryable", () => {
  it("retries rate limits, server errors and dropped connections", () => {
    for (const status of [408, 409, 429, 500, 503, 529]) expect(isRetryable(apiError(status))).toBe(true);
    expect(isRetryable(new APIConnectionError({ message: "socket hang up" }))).toBe(true);
    expect(isRetryable(new APIConnectionTimeoutError())).toBe(true);
  });

  it("does not retry client errors or non-API errors", () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryable(apiError(status))).toBe(false);
    expect(isRetryable(new Error("unreadable verdict"))).toBe(false);
    expect(isRetryable("boom")).toBe(false);
  });

  it("obeys an explicit x-should-retry header", () => {
    expect(isRetryable(apiError(500, { "x-should-retry": "false" }))).toBe(false);
    expect(isRetryable(apiError(400, { "x-should-retry": "true" }))).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("reads retry-after-ms, then retry-after seconds, then an HTTP date", () => {
    expect(retryAfterMs(apiError(429, { "retry-after-ms": "1500", "retry-after": "9" }))).toBe(1500);
    expect(retryAfterMs(apiError(429, { "retry-after": "3" }))).toBe(3000);
    const soon = new Date(Date.now() + 10_000).toUTCString();
    const ms = retryAfterMs(apiError(429, { "retry-after": soon }))!;
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("is undefined without a usable header", () => {
    expect(retryAfterMs(apiError(429))).toBeUndefined();
    expect(retryAfterMs(apiError(429, { "retry-after": "soon-ish" }))).toBeUndefined();
    expect(retryAfterMs(new Error("x"))).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("doubles from the base up to the cap, with full jitter below that ceiling", () => {
    const { o } = opts();
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, o, () => 1))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 20_000,
    ]);
    expect(backoffMs(3, o, () => 0)).toBe(0);
    expect(backoffMs(3, o, () => 0.5)).toBe(2000);
  });
});

describe("withRetry", () => {
  it("retries a 429 and counts both attempts", async () => {
    const { o, waits } = opts();
    const fn = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce("ok");
    const tally = { attempts: 0 };
    expect(await withRetry(fn, o, tally)).toBe("ok");
    expect(tally.attempts).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it("waits as long as retry-after asks instead of its own backoff", async () => {
    const { o, waits } = opts();
    const fn = vi.fn().mockRejectedValueOnce(apiError(529, { "retry-after": "7" })).mockResolvedValueOnce("ok");
    await withRetry(fn, o);
    expect(waits).toEqual([7000]);
  });

  it("gives up at once when retry-after is longer than it will wait", async () => {
    const { o, waits } = opts({ maxDelayMs: 5000 });
    const err = apiError(429, { "retry-after": "60" });
    const tally = { attempts: 0 };
    await expect(withRetry(vi.fn().mockRejectedValue(err), o, tally)).rejects.toBe(err);
    expect(tally.attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  it("stops after maxAttempts and rethrows the last error", async () => {
    const { o, waits } = opts();
    const last = apiError(503);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(500))
      .mockRejectedValueOnce(apiError(502))
      .mockRejectedValueOnce(new RateLimitError(429, {}, "slow down", new Headers()))
      .mockRejectedValueOnce(last);
    const tally = { attempts: 0 };
    await expect(withRetry(fn, o, tally)).rejects.toBe(last);
    expect(tally.attempts).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry an error that would fail the same way again", async () => {
    const { o, waits } = opts();
    for (const err of [new BadRequestError(400, {}, "bad", new Headers()), new NotFoundError(404, {}, "gone", new Headers())]) {
      const fn = vi.fn().mockRejectedValue(err);
      await expect(withRetry(fn, o)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(waits).toEqual([]);
  });

  it("makes a single attempt with maxAttempts 1", async () => {
    const { o } = opts({ maxAttempts: 1 });
    const fn = vi.fn().mockRejectedValue(apiError(529));
    await expect(withRetry(fn, o)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
