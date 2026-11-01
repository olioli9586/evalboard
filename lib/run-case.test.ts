import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError, BadRequestError } from "@anthropic-ai/sdk";
import { CaseError, runCase, type CaseRequest } from "./run-case";
import type { RetryOptions } from "./retry";

// runCase takes the client as an argument, so a plain object stands in for it.
function fakeClient(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function message(text: string, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10 }, stop_reason };
}

function overloaded(headers: Record<string, string> = {}) {
  return APIError.generate(529, { type: "error", error: { message: "Overloaded" } }, undefined, new Headers(headers));
}

const req: CaseRequest = {
  model: "claude-haiku-4-5",
  system: "Classify.",
  input: "I was charged twice.",
  expected: "billing",
  grader: "exact",
};

// Waits are slow on purpose so a latency that included them would show.
const retry: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => 1,
};

describe("runCase with retries", () => {
  it("retries an overloaded model call, counts the attempts, and times only the call that worked", async () => {
    const create = vi.fn().mockRejectedValueOnce(overloaded()).mockResolvedValueOnce(message("billing"));
    const { result, attempts } = await runCase(fakeClient(create), req, retry);
    expect(attempts).toBe(2);
    expect(result.pass).toBe(true);
    expect(result.latency_ms).toBeLessThan(50);
  });

  it("counts model and judge attempts together", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message("Refund the double charge."))
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce(message(JSON.stringify({ reasoning: "Same.", pass: true })));
    const { result, attempts } = await runCase(fakeClient(create), { ...req, grader: "judge" }, retry);
    expect(attempts).toBe(3);
    expect(result.reasoning).toBe("Same.");
    // The judge retry did not re-run the (already paid) model call.
    expect(create.mock.calls.map((c) => c[0].model)).toEqual(["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-8"]);
  });

  it("marks an exhausted retryable failure as retryable, with the API's retry-after", async () => {
    const create = vi.fn().mockRejectedValue(overloaded({ "retry-after": "0.01" }));
    const err = await runCase(fakeClient(create), req, retry).catch((e) => e);
    expect(err).toBeInstanceOf(CaseError);
    expect(err).toMatchObject({ kind: "model", attempts: 3, retryable: true, retryAfterMs: 10 });
    expect(err.message).toMatch(/Model call failed: 529/);
  });

  it("does not retry a bad request and marks it as not retryable", async () => {
    const create = vi.fn().mockRejectedValue(new BadRequestError(400, { message: "bad" }, undefined, new Headers()));
    const err = await runCase(fakeClient(create), req, retry).catch((e) => e);
    expect(err).toMatchObject({ kind: "model", attempts: 1, retryable: false });
  });

  it("does not retry an unreadable verdict", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message("Refund it."))
      .mockResolvedValueOnce(message('{"reasoning": "cut', "max_tokens"));
    const err = await runCase(fakeClient(create), { ...req, grader: "judge" }, retry).catch((e) => e);
    expect(err).toMatchObject({ kind: "judge", attempts: 2, retryable: false });
    expect(err.message).toMatch(/Grading failed: .*unreadable verdict/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports a refusal as its own kind", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("", "refusal"));
    const err = await runCase(fakeClient(create), req, retry).catch((e) => e);
    expect(err).toMatchObject({ kind: "refusal", retryable: false });
  });
});
