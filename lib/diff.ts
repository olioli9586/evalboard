import type { EvalCase } from "./eval";
import type { ResultRow, RunSummary } from "./store";

// Comparing two runs over the same dataset, case by case.

export type Transition = "pass-pass" | "fail-fail" | "fixed" | "regressed" | "ungraded";

export function transition(a: boolean | null | undefined, b: boolean | null | undefined): Transition {
  if (a == null || b == null) return "ungraded"; // errored, or no result yet
  if (a && b) return "pass-pass";
  if (!a && !b) return "fail-fail";
  return a && !b ? "regressed" : "fixed";
}

// Percent of graded cases that passed; null before anything is graded.
export function passRate(s: Pick<RunSummary, "graded" | "passed">): number | null {
  return s.graded ? Math.round((s.passed / s.graded) * 100) : null;
}

export interface DiffRow {
  position: number;
  input: string;
  expected: string;
  a: ResultRow | null;
  b: ResultRow | null;
  transition: Transition;
}

export function diffRuns(
  cases: (EvalCase & { position: number })[],
  a: ResultRow[],
  b: ResultRow[],
): { rows: DiffRow[]; counts: Record<Transition, number> } {
  const byPosition = (rows: ResultRow[]) => new Map(rows.map((r) => [r.position, r]));
  const ra = byPosition(a);
  const rb = byPosition(b);
  const counts: Record<Transition, number> = { "pass-pass": 0, "fail-fail": 0, fixed: 0, regressed: 0, ungraded: 0 };
  const rows = cases.map((c) => {
    const left = ra.get(c.position) ?? null;
    const right = rb.get(c.position) ?? null;
    const t = transition(left?.pass, right?.pass);
    counts[t]++;
    return { position: c.position, input: c.input, expected: c.expected, a: left, b: right, transition: t };
  });
  return { rows, counts };
}
