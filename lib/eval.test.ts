import { describe, expect, it } from "vitest";
import { cost, exactMatch, MODELS, normalizeAnswer, PRICES, SAMPLES } from "./eval";

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

describe("exactMatch", () => {
  it("ignores case, surrounding whitespace, and a trailing period", () => {
    expect(exactMatch("  Billing.\n", "billing")).toBe(true);
    expect(exactMatch("BUG", "bug")).toBe(true);
    expect(exactMatch("4", "4.")).toBe(true);
  });

  it("ignores a run of trailing punctuation", () => {
    expect(exactMatch("billing..", "billing")).toBe(true);
    expect(exactMatch("Account!!", "account")).toBe(true);
    expect(exactMatch("bug?", "bug")).toBe(true);
    expect(exactMatch("bug !", "bug")).toBe(true);
  });

  it("still distinguishes different answers", () => {
    expect(exactMatch("bug", "billing")).toBe(false);
    expect(exactMatch("feature request", "feature_request")).toBe(false);
    expect(exactMatch("billing issue", "billing")).toBe(false);
    expect(exactMatch("", "billing")).toBe(false);
  });

  it("keeps punctuation that is not trailing", () => {
    expect(normalizeAnswer("3.14")).toBe("3.14");
    expect(normalizeAnswer("e.g. this.")).toBe("e.g. this");
  });
});
