import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRun, loadRuns, saveRun, transition, type SavedRun } from "./history";

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

function run(id: string, at = "2026-01-01T00:00:00.000Z"): SavedRun {
  return {
    id,
    at,
    dataset: "custom",
    grader: "exact",
    system: "",
    caseKey: "[]",
    caseCount: 0,
    models: {},
  };
}

describe("transition", () => {
  it("classifies every pass/fail pair", () => {
    expect(transition(true, true)).toBe("pass-pass");
    expect(transition(false, false)).toBe("fail-fail");
    expect(transition(false, true)).toBe("fixed");
    expect(transition(true, false)).toBe("regressed");
  });

  it("is ungraded when either side errored", () => {
    expect(transition(null, true)).toBe("ungraded");
    expect(transition(false, null)).toBe("ungraded");
    expect(transition(null, null)).toBe("ungraded");
  });
});

describe("run storage", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty", () => {
    expect(loadRuns()).toEqual([]);
  });

  it("returns [] on the server", () => {
    vi.stubGlobal("window", undefined);
    expect(loadRuns()).toEqual([]);
  });

  it("saves newest first and persists", () => {
    saveRun(run("a"));
    const runs = saveRun(run("b"));
    expect(runs.map((r) => r.id)).toEqual(["b", "a"]);
    expect(loadRuns().map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("keeps at most 20 runs", () => {
    for (let i = 0; i < 25; i++) saveRun(run(`r${i}`));
    const runs = loadRuns();
    expect(runs).toHaveLength(20);
    expect(runs[0].id).toBe("r24");
    expect(runs.at(-1)!.id).toBe("r5");
  });

  it("deletes by id", () => {
    saveRun(run("a"));
    saveRun(run("b"));
    expect(deleteRun("a").map((r) => r.id)).toEqual(["b"]);
    expect(loadRuns().map((r) => r.id)).toEqual(["b"]);
  });

  it("recovers from corrupt JSON", () => {
    localStorage.setItem("evalboard-runs", "{not json");
    expect(loadRuns()).toEqual([]);
  });

  it("ignores valid JSON that is not a list of runs", () => {
    for (const raw of ["null", "{}", '"x"', "42"]) {
      localStorage.setItem("evalboard-runs", raw);
      expect(loadRuns()).toEqual([]);
      expect(saveRun(run("a")).map((r) => r.id)).toEqual(["a"]);
    }
  });

  it("drops malformed entries but keeps good ones", () => {
    localStorage.setItem("evalboard-runs", JSON.stringify([null, { id: 1 }, run("ok")]));
    expect(loadRuns().map((r) => r.id)).toEqual(["ok"]);
  });

  it("still returns the updated list when storage is full", () => {
    saveRun(run("a"));
    const quota = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(saveRun(run("b")).map((r) => r.id)).toEqual(["b", "a"]);
    expect(deleteRun("a").map((r) => r.id)).toEqual([]);
    quota.mockRestore();
  });
});

