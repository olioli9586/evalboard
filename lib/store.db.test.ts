import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CaseResult, EvalCase } from "./eval";
import { withTransaction } from "./db";
import {
  createRuns,
  finishRun,
  getRun,
  insertResult,
  markRunning,
  pendingCases,
  reserveCases,
  runSummary,
  spentTodayUsd,
  upsertDataset,
} from "./store";
import { closeTestPool, freshDb } from "./test-db";

const CASES: EvalCase[] = [
  { input: "charged twice", expected: "billing" },
  { input: "export crashes", expected: "bug" },
  { input: "add dark mode", expected: "feature_request" },
];

function graded(pass: boolean, overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    output: pass ? "billing" : "bug",
    pass,
    reasoning: "",
    latency_ms: 100,
    input_tokens: 10,
    output_tokens: 2,
    cost_usd: 0.001,
    model_used: "claude-haiku-4-5",
    ...overrides,
  };
}

let db: pg.Pool;

beforeEach(async () => {
  db = await freshDb();
});
afterAll(closeTestPool);

async function seedRun(cases = CASES) {
  const ds = await withTransaction(
    (c) => upsertDataset(c, { name: "triage", source: "sample", cases }),
    db,
  );
  const [run] = await createRuns(db, {
    datasetId: ds.id,
    groupId: randomUUID(),
    grader: "exact",
    totalCases: cases.length,
    variants: [{ model: "claude-haiku-4-5", systemPrompt: "Classify." }],
  });
  return run;
}

describe("upsertDataset", () => {
  it("stores the cases once and reuses the dataset for the same cases", async () => {
    const first = await withTransaction(
      (c) => upsertDataset(c, { name: "triage", source: "sample", cases: CASES }),
      db,
    );
    const again = await withTransaction(
      (c) => upsertDataset(c, { name: "renamed", source: "custom", cases: CASES }),
      db,
    );
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });

    const { rows } = await db.query("select position, input from cases order by position");
    expect(rows).toEqual(CASES.map((c, i) => ({ position: i, input: c.input })));
  });

  it("treats different cases as a different dataset", async () => {
    const a = await upsertDataset(db, { name: "a", source: "custom", cases: CASES });
    const b = await upsertDataset(db, { name: "b", source: "custom", cases: CASES.slice(1) });
    expect(a.id).not.toBe(b.id);
  });

  it("keeps one dataset when the same cases arrive concurrently", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTransaction((c) => upsertDataset(c, { name: "x", source: "custom", cases: CASES }), db),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await db.query("select count(*)::int as n from cases");
    expect(rows[0].n).toBe(CASES.length);
  });

  it("leaves nothing behind when the transaction fails", async () => {
    await expect(
      withTransaction(async (c) => {
        await upsertDataset(c, { name: "x", source: "custom", cases: CASES });
        throw new Error("boom");
      }, db),
    ).rejects.toThrow("boom");
    const { rows } = await db.query("select count(*)::int as n from datasets");
    expect(rows[0].n).toBe(0);
  });
});

describe("createRuns", () => {
  it("creates one queued run per variant in the same group", async () => {
    const ds = await upsertDataset(db, { name: "t", source: "sample", cases: CASES });
    const groupId = randomUUID();
    const runs = await createRuns(db, {
      datasetId: ds.id,
      groupId,
      grader: "exact",
      totalCases: CASES.length,
      variants: [
        { model: "claude-haiku-4-5", systemPrompt: "A prompt", promptLabel: "A" },
        { model: "claude-haiku-4-5", systemPrompt: "B prompt", promptLabel: "B" },
        { model: "claude-sonnet-4-6", systemPrompt: "A prompt" },
      ],
    });
    expect(runs.map((r) => [r.model, r.promptLabel, r.status])).toEqual([
      ["claude-haiku-4-5", "A", "queued"],
      ["claude-haiku-4-5", "B", "queued"],
      ["claude-sonnet-4-6", null, "queued"],
    ]);
    expect(runs.every((r) => r.groupId === groupId && r.totalCases === 3)).toBe(true);
  });
});

describe("run lifecycle", () => {
  it("keeps the first start time and never reopens a finished run", async () => {
    const run = await seedRun();
    const started = await markRunning(db, run.id);
    expect(started?.status).toBe("running");
    const again = await markRunning(db, run.id);
    expect(again?.startedAt).toEqual(started?.startedAt);

    expect((await finishRun(db, run.id, "succeeded"))?.status).toBe("succeeded");
    // A late duplicate batch can't move it back or re-finish it.
    expect(await markRunning(db, run.id)).toBeNull();
    expect(await finishRun(db, run.id, "failed", "late")).toBeNull();
    expect((await getRun(db, run.id))?.status).toBe("succeeded");
  });
});

describe("results", () => {
  it("returns pending cases in order and skips ones that have a result", async () => {
    const run = await seedRun();
    const pending = await pendingCases(db, run.id, 10);
    expect(pending.map((c) => c.input)).toEqual(CASES.map((c) => c.input));

    await insertResult(db, run.id, pending[0].id, graded(true));
    await insertResult(db, run.id, pending[2].id, { error: "refused" });
    const left = await pendingCases(db, run.id, 10);
    expect(left.map((c) => c.position)).toEqual([1]);
    expect(await pendingCases(db, run.id, 0)).toEqual([]);
  });

  it("writes each (run, case) once, so a retried batch can't change the score", async () => {
    const run = await seedRun();
    const [c0, c1] = await pendingCases(db, run.id, 2);

    expect(await insertResult(db, run.id, c0.id, graded(true))).toBe(true);
    expect(await insertResult(db, run.id, c1.id, graded(false))).toBe(true);
    const before = await runSummary(db, run.id);

    // The same batch delivered again, this time with different answers.
    expect(await insertResult(db, run.id, c0.id, graded(false), 2)).toBe(false);
    expect(await insertResult(db, run.id, c1.id, graded(true), 2)).toBe(false);

    expect(await runSummary(db, run.id)).toEqual(before);
    const { rows } = await db.query("select count(*)::int as n from results where run_id = $1", [run.id]);
    expect(rows[0].n).toBe(2);
  });

  it("summarizes from the rows: pass rate over graded cases, errors counted apart", async () => {
    const run = await seedRun();
    const [c0, c1, c2] = await pendingCases(db, run.id, 3);
    await insertResult(db, run.id, c0.id, graded(true, { latency_ms: 100, cost_usd: 0.002 }));
    await insertResult(db, run.id, c1.id, graded(false, { latency_ms: 300, cost_usd: 0.001 }));
    await insertResult(db, run.id, c2.id, { error: "upstream 529" }, 4);

    expect(await runSummary(db, run.id)).toEqual({
      done: 3,
      graded: 2,
      passed: 1,
      errored: 1,
      avgLatencyMs: 200,
      costUsd: 0.003,
    });
    expect(await spentTodayUsd(db)).toBeCloseTo(0.003, 6);
  });
});

describe("reserveCases", () => {
  it("never lets concurrent requests go over the daily limit", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => reserveCases(db, "1.2.3.4", 1, 10)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(10);
    const { rows } = await db.query("select cases from usage_daily where ip = '1.2.3.4'");
    expect(rows[0].cases).toBe(10);
  });

  it("is all or nothing and tracks each IP separately", async () => {
    expect(await reserveCases(db, "a", 8, 10)).toBe(true);
    expect(await reserveCases(db, "a", 3, 10)).toBe(false); // would make 11
    expect(await reserveCases(db, "a", 2, 10)).toBe(true);
    expect(await reserveCases(db, "b", 11, 10)).toBe(false);
    expect(await reserveCases(db, "b", 10, 10)).toBe(true);
  });
});
