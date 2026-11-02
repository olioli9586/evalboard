import { describe, expect, it } from "vitest";
import { diffRuns, passRate, transition } from "./diff";
import type { ResultRow } from "./store";

describe("transition", () => {
  it("classifies every pass/fail pair", () => {
    expect(transition(true, true)).toBe("pass-pass");
    expect(transition(false, false)).toBe("fail-fail");
    expect(transition(false, true)).toBe("fixed");
    expect(transition(true, false)).toBe("regressed");
  });

  it("is ungraded when either side errored or has no result yet", () => {
    expect(transition(null, true)).toBe("ungraded");
    expect(transition(false, null)).toBe("ungraded");
    expect(transition(undefined, true)).toBe("ungraded");
    expect(transition(null, undefined)).toBe("ungraded");
  });
});

describe("passRate", () => {
  it("is over graded cases and null before any", () => {
    expect(passRate({ graded: 8, passed: 7 })).toBe(88);
    expect(passRate({ graded: 0, passed: 0 })).toBeNull();
  });
});

function row(position: number, pass: boolean | null): ResultRow {
  return {
    position,
    output: String(pass),
    pass,
    error: pass === null ? "refused" : null,
    latencyMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    reasoning: "",
    modelUsed: "claude-haiku-4-5",
    attempts: 1,
  };
}

describe("diffRuns", () => {
  it("lines results up by position and counts each kind of change", () => {
    const cases = [0, 1, 2, 3, 4].map((position) => ({ position, input: `q${position}`, expected: "a" }));
    // Results arrive in any order; case 4 has no result in B yet.
    const a = [row(3, true), row(0, true), row(1, false), row(2, true), row(4, false)];
    const b = [row(0, true), row(1, true), row(2, false), row(3, null)];
    const { rows, counts } = diffRuns(cases, a, b);
    expect(rows.map((r) => r.transition)).toEqual(["pass-pass", "fixed", "regressed", "ungraded", "ungraded"]);
    expect(rows[1]).toMatchObject({ input: "q1", expected: "a", a: { pass: false }, b: { pass: true } });
    expect(rows[4].b).toBeNull();
    expect(counts).toEqual({ "pass-pass": 1, "fail-fail": 0, fixed: 1, regressed: 1, ungraded: 2 });
  });
});
