import type { GraderKind } from "./eval";

// Saved-run history for diffing, kept in localStorage. A run summary stores
// per-case pass booleans (null = errored/skipped) rather than full outputs —
// small enough to keep ~20 runs, rich enough to diff case-by-case.

export interface SavedModelResult {
  passes: (boolean | null)[];
  passRate: number; // 0-100, over graded cases
  avgMs: number;
  cost: number;
}

export interface SavedRun {
  id: string;
  at: string; // ISO timestamp
  dataset: string;
  grader: GraderKind;
  system: string;
  // Two runs are diffable only if they evaluated the same cases.
  caseKey: string;
  caseCount: number;
  models: Record<string, SavedModelResult>;
}

const KEY = "evalboard-runs";
const MAX_RUNS = 20;

export function loadRuns(): SavedRun[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    // Valid JSON of the wrong shape (e.g. "null") would otherwise crash the page.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SavedRun =>
        typeof r === "object" &&
        r !== null &&
        typeof r.id === "string" &&
        typeof r.models === "object" &&
        r.models !== null,
    );
  } catch {
    return [];
  }
}

// Storage can be full or unavailable (private browsing); history is a
// convenience, so keep going with the in-memory list rather than throw.
function persist(runs: SavedRun[]): SavedRun[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs));
  } catch {
    // ignore
  }
  return runs;
}

export function saveRun(run: SavedRun): SavedRun[] {
  return persist([run, ...loadRuns()].slice(0, MAX_RUNS));
}

export function deleteRun(id: string): SavedRun[] {
  return persist(loadRuns().filter((r) => r.id !== id));
}

export type Transition = "pass-pass" | "fail-fail" | "fixed" | "regressed" | "ungraded";

export function transition(a: boolean | null, b: boolean | null): Transition {
  if (a === null || b === null) return "ungraded";
  if (a && b) return "pass-pass";
  if (!a && !b) return "fail-fail";
  return a && !b ? "regressed" : "fixed";
}
