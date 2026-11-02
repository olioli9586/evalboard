import { describe, expect, it } from "vitest";
import { SAMPLES } from "./eval";
import { MAX_IMPORT_RUNS, parseImport } from "./import";

const triage = SAMPLES[0];

// A v1 history entry as lib/history.ts used to save it.
function legacy(overrides: Record<string, unknown> = {}) {
  const inputs = triage.cases.map((c) => c.input);
  return {
    id: crypto.randomUUID(),
    at: "2026-09-20T10:00:00.000Z",
    dataset: triage.name,
    grader: "exact",
    system: triage.system,
    caseKey: JSON.stringify(inputs),
    caseCount: inputs.length,
    models: {
      "claude-haiku-4-5": { passes: inputs.map((_, i) => i !== 2), passRate: 88, avgMs: 400, cost: 0.001 },
      "claude-sonnet-4-6": { passes: inputs.map((_, i) => (i === 5 ? null : true)), passRate: 100, avgMs: 900, cost: 0.004 },
    },
    ...overrides,
  };
}

function ok(body: unknown, now?: Date) {
  const out = parseImport(body, now);
  if ("error" in out) throw new Error(out.error);
  return out;
}

describe("parseImport", () => {
  it("recognizes a built-in sample and brings back its expected answers", () => {
    const entry = legacy();
    const { runs, skipped } = ok({ runs: [entry] });
    expect(skipped).toBe(0);
    expect(runs[0]).toMatchObject({ legacyId: entry.id, source: "sample", datasetName: triage.name, grader: "exact" });
    expect(runs[0].cases).toEqual(triage.cases);
    expect(runs[0].at).toEqual(new Date(entry.at));
    expect(runs[0].models).toEqual([
      { model: "claude-haiku-4-5", passes: entry.models["claude-haiku-4-5"].passes },
      { model: "claude-sonnet-4-6", passes: entry.models["claude-sonnet-4-6"].passes },
    ]);
  });

  it("keeps a custom dataset's inputs, with the expected answers v1 never saved left empty", () => {
    const entry = legacy({
      dataset: "custom",
      caseKey: JSON.stringify(["2+2?", "Capital of France?"]),
      models: { "claude-haiku-4-5": { passes: [true, false] } },
    });
    const [run] = ok({ runs: [entry] }).runs;
    expect(run).toMatchObject({ source: "import", datasetName: "custom" });
    expect(run.cases).toEqual([
      { input: "2+2?", expected: "" },
      { input: "Capital of France?", expected: "" },
    ]);
  });

  it("skips malformed entries and duplicates instead of failing the import", () => {
    const good = legacy();
    const bad = [
      null,
      "x",
      legacy({ id: "not-a-uuid" }),
      legacy({ grader: "fuzzy" }),
      legacy({ at: "yesterday-ish" }),
      legacy({ caseKey: "{nope" }),
      legacy({ caseKey: JSON.stringify([]) }),
      legacy({ caseKey: JSON.stringify(Array.from({ length: 21 }, (_, i) => `q${i}`)) }),
      legacy({ caseKey: JSON.stringify([1, 2]) }),
      legacy({ models: {} }),
      legacy({ models: { "gpt-4": { passes: triage.cases.map(() => true) } } }),
      legacy({ models: { "claude-haiku-4-5": { passes: [true] } } }), // wrong length
      legacy({ models: { "claude-haiku-4-5": { passes: triage.cases.map(() => "yes") } } }),
      legacy({ system: 7 }),
      { ...good }, // same id twice
    ];
    const { runs, skipped } = ok({ runs: [good, ...bad] });
    expect(runs.map((r) => r.legacyId)).toEqual([good.id]);
    expect(skipped).toBe(bad.length);
  });

  it("moves a future timestamp to now", () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const [run] = ok({ runs: [legacy({ at: "2030-01-01T00:00:00.000Z" })] }, now).runs;
    expect(run.at).toEqual(now);
  });

  it("rejects a body that is not a list, too many runs, or too much text", () => {
    expect(parseImport(null)).toEqual({ error: "runs must be a list." });
    expect(parseImport({ runs: "x" })).toEqual({ error: "runs must be a list." });
    expect("error" in parseImport({ runs: Array.from({ length: MAX_IMPORT_RUNS + 1 }, () => legacy()) })).toBe(true);
    const long = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(4000, "x"));
    const big = Array.from({ length: 2 }, () =>
      legacy({ caseKey: JSON.stringify(long), models: { "claude-haiku-4-5": { passes: long.map(() => true) } } }),
    );
    expect(parseImport({ runs: big })).toEqual({ error: "This history is too large to import." });
  });
});
