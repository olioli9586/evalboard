import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// The Anthropic client is replaced with a stub: no network, no API key needed.
const create = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    static NotFoundError = actual.NotFoundError;
    static APIError = actual.APIError;
    messages = { create };
  }
  return { ...actual, default: FakeAnthropic };
});

function message(text: string, usage = { input_tokens: 100, output_tokens: 10 }, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], usage, stop_reason };
}

let ipCounter = 0;
function request(body: unknown, ip = `10.0.0.${++ipCounter}`): NextRequest {
  return new Request("http://localhost/api/run-case", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const base = {
  model: "claude-haiku-4-5",
  system: "Classify.",
  input: "I was charged twice.",
  expected: "billing",
  grader: "exact",
};

async function loadRoute() {
  return (await import("./route")).POST;
}

describe("POST /api/run-case", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 500 when no API key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const POST = await loadRoute();
    const res = await POST(request(base));
    expect(res.status).toBe(500);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and unknown models", async () => {
    const POST = await loadRoute();
    expect((await POST(request("{nope"))).status).toBe(400);
    const res = await POST(request({ ...base, model: "gpt-4" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown model/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects missing or oversized input", async () => {
    const POST = await loadRoute();
    expect((await POST(request({ ...base, input: "" }))).status).toBe(400);
    expect((await POST(request({ ...base, input: "x".repeat(4001) }))).status).toBe(400);
    expect((await POST(request({ ...base, system: "x".repeat(4001) }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("grades exact match with normalization and reports telemetry", async () => {
    create.mockResolvedValueOnce(message("  Billing. ", { input_tokens: 1000, output_tokens: 200 }));
    const POST = await loadRoute();
    const res = await POST(request(base));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      output: "Billing.",
      pass: true,
      reasoning: "",
      input_tokens: 1000,
      output_tokens: 200,
      model_used: "claude-haiku-4-5",
    });
    expect(body.cost_usd).toBeCloseTo((1000 * 1 + 200 * 5) / 1e6);
    expect(typeof body.latency_ms).toBe("number");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "claude-haiku-4-5",
      system: "Classify.",
      messages: [{ role: "user", content: "I was charged twice." }],
    });
  });

  it("fails exact match on a different answer", async () => {
    create.mockResolvedValueOnce(message("bug"));
    const POST = await loadRoute();
    const body = await (await POST(request(base))).json();
    expect(body.pass).toBe(false);
  });

  it("uses the judge verdict and adds the judge's cost", async () => {
    create
      .mockResolvedValueOnce(message("Renew the vendor contract by Friday.", { input_tokens: 100, output_tokens: 20 }))
      .mockResolvedValueOnce(
        message(JSON.stringify({ reasoning: "Same action.", pass: true }), { input_tokens: 400, output_tokens: 40 }),
      );
    const POST = await loadRoute();
    const res = await POST(request({ ...base, grader: "judge", expected: "Start the renewal before Friday." }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pass).toBe(true);
    expect(body.reasoning).toBe("Same action.");
    const target = (100 * 1 + 20 * 5) / 1e6;
    const judge = (400 * 5 + 40 * 25) / 1e6; // default judge is Opus 4.8
    expect(body.cost_usd).toBeCloseTo(target + judge);
    expect(create.mock.calls[1][0].model).toBe("claude-opus-4-8");
    expect(create.mock.calls[1][0].messages[0].content).toContain("Renew the vendor contract by Friday.");
  });

  it("falls back to Opus 4.8 when the requested model is retired", async () => {
    const { NotFoundError } = await import("@anthropic-ai/sdk");
    create
      .mockRejectedValueOnce(new NotFoundError(404, {}, "model not found", new Headers()))
      .mockResolvedValueOnce(message("billing"));
    const POST = await loadRoute();
    const body = await (await POST(request(base))).json();
    expect(body.model_used).toBe("claude-opus-4-8");
    expect(body.pass).toBe(true);
    expect(create.mock.calls[1][0].model).toBe("claude-opus-4-8");
  });

  it("returns 422 when the model refuses", async () => {
    create.mockResolvedValueOnce(message("", undefined, "refusal"));
    const POST = await loadRoute();
    expect((await POST(request(base))).status).toBe(422);
  });

  it("enforces the per-IP daily budget", async () => {
    vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "2");
    vi.resetModules();
    create.mockResolvedValue(message("billing"));
    const POST = await loadRoute();
    expect((await POST(request(base, "9.9.9.9"))).status).toBe(200);
    expect((await POST(request(base, "9.9.9.9, 10.0.0.1"))).status).toBe(200);
    const res = await POST(request(base, "9.9.9.9"));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/budget/);
  });
});
