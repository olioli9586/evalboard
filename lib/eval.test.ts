import { describe, expect, it } from "vitest";
import { cost, MODELS, PRICES, SAMPLES } from "./eval";

describe("cost", () => {
  it("prices input and output tokens per million", () => {
    // haiku: $1 in / $5 out per MTok
    expect(cost("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1);
    expect(cost("claude-haiku-4-5", 0, 1_000_000)).toBeCloseTo(5);
    expect(cost("claude-sonnet-4-6", 2000, 500)).toBeCloseTo((2000 * 3 + 500 * 15) / 1e6);
  });

  it("falls back to Opus pricing for unknown models", () => {
    expect(cost("claude-unknown", 1000, 1000)).toBe(cost("claude-opus-4-8", 1000, 1000));
  });

  it("is zero for zero tokens", () => {
    expect(cost("claude-opus-4-8", 0, 0)).toBe(0);
  });
});

describe("reference data", () => {
  it("exposes every priced model", () => {
    expect(MODELS).toEqual(Object.keys(PRICES));
  });

  it("ships well-formed sample datasets", () => {
    for (const s of SAMPLES) {
      expect(["exact", "judge"]).toContain(s.grader);
      expect(s.cases.length).toBeGreaterThan(0);
      for (const c of s.cases) {
        expect(c.input.trim()).not.toBe("");
        expect(c.expected.trim()).not.toBe("");
      }
    }
  });
});
