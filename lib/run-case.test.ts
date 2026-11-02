import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { APIError, BadRequestError, NotFoundError } from "@anthropic-ai/sdk";
import { CaseError, runCase, type CaseRequest } from "./run-case";
import type { RetryOptions } from "./retry";

// runCase takes the client as an argument, so a plain object stands in for it.
function fakeClient(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function message(text: string, stop_reason = "end_turn", usage = { input_tokens: 100, output_tokens: 10 }) {
  return { content: [{ type: "text", text }], usage, stop_reason };
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
    expect(err.message).toMatch(/Grading failed: .*unreadable verdict.*max_tokens/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports a refusal as its own kind", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("", "refusal"));
    const err = await runCase(fakeClient(create), req, retry).catch((e) => e);
    expect(err).toMatchObject({ kind: "refusal", retryable: false });
  });
});

// Grading and fallback, moved here from the v1 /api/run-case route tests when
// that route was removed.
describe("runCase grading", () => {
  it("grades exact match with normalization and reports telemetry", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("  Billing. ", "end_turn", { input_tokens: 1000, output_tokens: 200 }));
    const { result } = await runCase(fakeClient(create), req);
    expect(result).toMatchObject({
      output: "Billing.",
      pass: true,
      reasoning: "",
      input_tokens: 1000,
      output_tokens: 200,
      model_used: "claude-haiku-4-5",
    });
    expect(result.cost_usd).toBeCloseTo((1000 * 1 + 200 * 5) / 1e6);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      system: "Classify.",
      messages: [{ role: "user", content: "I was charged twice." }],
    });
  });

  it("fails exact match on a different answer", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("bug"));
    expect((await runCase(fakeClient(create), req)).result.pass).toBe(false);
  });

  it("sends no system prompt when it is empty", async () => {
    const create = vi.fn().mockResolvedValueOnce(message("billing"));
    await runCase(fakeClient(create), { ...req, system: "" });
    expect(create.mock.calls[0][0].system).toBeUndefined();
  });

  it("uses the judge verdict and adds the judge's cost", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message("Renew the vendor contract by Friday.", "end_turn", { input_tokens: 100, output_tokens: 20 }))
      .mockResolvedValueOnce(
        message(JSON.stringify({ reasoning: "Same action.", pass: true }), "end_turn", { input_tokens: 400, output_tokens: 40 }),
      );
    const { result } = await runCase(fakeClient(create), {
      ...req,
      grader: "judge",
      expected: "Start the renewal before Friday.",
    });
    expect(result).toMatchObject({ pass: true, reasoning: "Same action." });
    const target = (100 * 1 + 20 * 5) / 1e6;
    const judge = (400 * 5 + 40 * 25) / 1e6; // default judge is Opus 4.8
    expect(result.cost_usd).toBeCloseTo(target + judge);
    expect(create.mock.calls[1][0].model).toBe("claude-opus-4-8");
    expect(create.mock.calls[1][0].messages[0].content).toContain("Renew the vendor contract by Friday.");
  });

  it("fails grading when the verdict has no pass value", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(message("Renew the contract."))
      .mockResolvedValueOnce(message(JSON.stringify({ reasoning: "hmm" })));
    const err = await runCase(fakeClient(create), { ...req, grader: "judge" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "judge", retryable: false });
    expect(err.message).toMatch(/no pass\/fail value/);
  });

  it("falls back to Opus 4.8 when the requested model is retired", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new NotFoundError(404, {}, "model not found", new Headers()))
      .mockResolvedValueOnce(message("billing"));
    const { result } = await runCase(fakeClient(create), req);
    expect(result).toMatchObject({ model_used: "claude-opus-4-8", pass: true });
    expect(create.mock.calls[1][0].model).toBe("claude-opus-4-8");
  });

  it("reports the fallback model's own failure", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new NotFoundError(404, {}, "model not found", new Headers()))
      .mockRejectedValueOnce(new Error("socket hang up"));
    const err = await runCase(fakeClient(create), req).catch((e) => e);
    expect(err).toMatchObject({ kind: "model" });
    expect(err.message).toMatch(/Model call failed: socket hang up/);
  });

  it("does not fall back from the fallback model itself", async () => {
    const create = vi.fn().mockRejectedValueOnce(new NotFoundError(404, {}, "gone", new Headers()));
    const err = await runCase(fakeClient(create), { ...req, model: "claude-opus-4-8" }).catch((e) => e);
    expect(err).toBeInstanceOf(CaseError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
