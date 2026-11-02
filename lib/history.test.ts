import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToHistory,
  clearLegacyRuns,
  loadHistory,
  loadLegacyRuns,
  MAX_HISTORY,
  pruneHistory,
  removeFromHistory,
} from "./history";

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

const id = () => crypto.randomUUID();

describe("history", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty, and is empty on the server", () => {
    expect(loadHistory()).toEqual([]);
    vi.stubGlobal("window", undefined);
    expect(loadHistory()).toEqual([]);
  });

  it("adds newest first, without duplicates, and persists", () => {
    const [a, b, c] = [id(), id(), id()];
    addToHistory([a]);
    expect(addToHistory([b, c, a])).toEqual([b, c, a]);
    expect(loadHistory()).toEqual([b, c, a]);
  });

  it(`keeps at most ${MAX_HISTORY} ids`, () => {
    const ids = Array.from({ length: MAX_HISTORY + 5 }, id);
    for (const x of ids) addToHistory([x]);
    const kept = loadHistory();
    expect(kept).toHaveLength(MAX_HISTORY);
    expect(kept[0]).toBe(ids.at(-1));
  });

  it("removes one id, or every id the server doesn't know", () => {
    const [a, b, c] = [id(), id(), id()];
    addToHistory([a, b, c]);
    expect(removeFromHistory(b)).toEqual([a, c]);
    expect(pruneHistory(new Set([c]))).toEqual([c]);
  });

  it("ignores corrupt JSON, the wrong shape, and ids that aren't run ids", () => {
    for (const raw of ["{not json", "null", "{}", '"x"', "42"]) {
      localStorage.setItem("evalboard-history", raw);
      expect(loadHistory()).toEqual([]);
    }
    const good = id();
    localStorage.setItem("evalboard-history", JSON.stringify([good, 7, "1; drop", null]));
    expect(loadHistory()).toEqual([good]);
  });

  it("still returns the updated list when storage is full", () => {
    const [a, b] = [id(), id()];
    addToHistory([a]);
    const quota = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(addToHistory([b])).toEqual([b, a]);
    quota.mockRestore();
  });

  it("reads the v1 history for the import and clears it after", () => {
    expect(loadLegacyRuns()).toEqual([]);
    localStorage.setItem("evalboard-runs", JSON.stringify([{ id: "x" }]));
    expect(loadLegacyRuns()).toEqual([{ id: "x" }]);
    clearLegacyRuns();
    expect(loadLegacyRuns()).toEqual([]);
    localStorage.setItem("evalboard-runs", "{not json");
    expect(loadLegacyRuns()).toEqual([]);
  });
});
