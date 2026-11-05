import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CaseResult, EvalCase } from "./eval";
import { withTransaction } from "./db";
import {
  createRuns,
  finishRun,
  getDataset,
  getRun,
  insertResult,
  listCases,
  listGroupRuns,
  listResults,
  listRunsById,
  markRunning,
  pendingCases,
  reopenRun,
  reserveCases,
  runSummary,
  setHumanLabel,
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

describe("reopenRun", () => {
  const idleSince = () => new Date(Date.now() - 15 * 60_000);
  // Moves a run's timestamps, and its results', an hour into the past.
  const age = async (runId: string) => {
    await db.query(
      `update runs set created_at = created_at - interval '1 hour', started_at = started_at - interval '1 hour',
         last_delivery_at = last_delivery_at - interval '1 hour' where id = $1`,
      [runId],
    );
    await db.query("update results set created_at = created_at - interval '1 hour' where run_id = $1", [runId]);
  };

  it("reopens a failed run and clears its error", async () => {
    const run = await seedRun();
    await markRunning(db, run.id);
    await finishRun(db, run.id, "failed", "Gave up after 8 failed attempts.");
    const reopened = await reopenRun(db, run.id, idleSince());
    expect(reopened).toMatchObject({ status: "running", error: null, finishedAt: null });
    expect(reopened?.resumedAt).toBeInstanceOf(Date);
  });

  it("reopens an unfinished run only once it has been idle long enough", async () => {
    const run = await seedRun();
    await markRunning(db, run.id);
    const [first] = await pendingCases(db, run.id, 1);
    await insertResult(db, run.id, first.id, graded(true));
    expect(await reopenRun(db, run.id, idleSince())).toBeNull();

    await age(run.id);
    expect((await reopenRun(db, run.id, idleSince()))?.status).toBe("running");
    // The resume itself counts as activity.
    expect(await reopenRun(db, run.id, idleSince())).toBeNull();
  });

  it("counts a delivery as activity even when its batch wrote nothing", async () => {
    const run = await seedRun();
    await markRunning(db, run.id);
    await age(run.id);
    // A chain still retrying a failing batch: deliveries, but no results.
    await markRunning(db, run.id);
    expect(await reopenRun(db, run.id, idleSince())).toBeNull();
    await age(run.id);
    expect((await reopenRun(db, run.id, idleSince()))?.status).toBe("running");
  });

  it("never reopens a finished run", async () => {
    const run = await seedRun();
    await markRunning(db, run.id);
    await finishRun(db, run.id, "succeeded");
    await age(run.id);
    expect(await reopenRun(db, run.id, idleSince())).toBeNull();
    expect((await getRun(db, run.id))?.status).toBe("succeeded");
  });

  it("lets only one of two concurrent resumes through", async () => {
    const run = await seedRun();
    await finishRun(db, run.id, "failed", "Could not queue the run.");
    await age(run.id); // so only the first resume's resumed_at can stop the second
    const both = await Promise.all([reopenRun(db, run.id, idleSince()), reopenRun(db, run.id, idleSince())]);
    expect(both.filter(Boolean)).toHaveLength(1);
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

describe("reads for the run pages", () => {
  it("lists results in dataset order, keyed by position, with pending cases left out", async () => {
    const run = await seedRun();
    const [c0, , c2] = await pendingCases(db, run.id, 3);
    await insertResult(db, run.id, c2.id, graded(false, { reasoning: "Wrong label.", cost_usd: 0.0025 }), 3);
    await insertResult(db, run.id, c0.id, graded(true));

    const rows = await listResults(db, run.id);
    expect(rows.map((r) => r.position)).toEqual([0, 2]);
    expect(rows[1]).toEqual({
      position: 2,
      output: "bug",
      pass: false,
      error: null,
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.0025,
      reasoning: "Wrong label.",
      modelUsed: "claude-haiku-4-5",
      attempts: 3,
      humanPass: null,
    });
  });

  it("labels graded results by position, clears a label, and refuses errored or missing ones", async () => {
    const run = await seedRun();
    const [c0, c1] = await pendingCases(db, run.id, 2);
    await insertResult(db, run.id, c0.id, graded(true));
    await insertResult(db, run.id, c1.id, { error: "refused" });

    expect(await setHumanLabel(db, run.id, 0, false)).toBe(true);
    expect((await listResults(db, run.id)).map((r) => [r.position, r.pass, r.humanPass])).toEqual([
      [0, true, false],
      [1, null, null],
    ]);
    // The judge's verdict is untouched, and the score with it.
    expect(await runSummary(db, run.id)).toMatchObject({ graded: 1, passed: 1 });

    expect(await setHumanLabel(db, run.id, 0, null)).toBe(true);
    expect((await listResults(db, run.id))[0].humanPass).toBeNull();
    expect(await setHumanLabel(db, run.id, 1, true)).toBe(false); // errored
    expect(await setHumanLabel(db, run.id, 2, true)).toBe(false); // no result yet
    expect(await setHumanLabel(db, randomUUID(), 0, true)).toBe(false);
  });

  it("reads a dataset and its cases in order", async () => {
    const run = await seedRun();
    expect(await getDataset(db, run.datasetId)).toMatchObject({ name: "triage", source: "sample", caseCount: 3 });
    expect((await listCases(db, run.datasetId)).map((c) => [c.position, c.input])).toEqual(
      CASES.map((c, i) => [i, c.input]),
    );
    expect(await getDataset(db, randomUUID())).toBeNull();
  });

  it("lists runs by id with their scores, newest first, skipping unknown ids", async () => {
    const older = await seedRun();
    const newer = await seedRun();
    await db.query("update runs set created_at = now() - interval '1 hour' where id = $1", [older.id]);
    const [c0, c1] = await pendingCases(db, newer.id, 2);
    await insertResult(db, newer.id, c0.id, graded(true));
    await insertResult(db, newer.id, c1.id, { error: "refused" });

    const items = await listRunsById(db, [older.id, randomUUID(), newer.id]);
    expect(items.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(items[0]).toMatchObject({ datasetName: "triage", status: "queued", model: "claude-haiku-4-5" });
    expect(items[0].summary).toEqual({ done: 2, graded: 1, passed: 1, errored: 1, avgLatencyMs: 100, costUsd: 0.001 });
    // A run with no results still comes back, scored zero.
    expect(items[1].summary).toEqual({ done: 0, graded: 0, passed: 0, errored: 0, avgLatencyMs: 0, costUsd: 0 });
    expect(await listRunsById(db, [])).toEqual([]);
  });

  it("lists the runs launched together", async () => {
    const ds = await withTransaction((c) => upsertDataset(c, { name: "triage", source: "sample", cases: CASES }), db);
    const groupId = randomUUID();
    const runs = await createRuns(db, {
      datasetId: ds.id,
      groupId,
      grader: "exact",
      totalCases: 3,
      variants: [
        { model: "claude-sonnet-4-6", systemPrompt: "A" },
        { model: "claude-haiku-4-5", systemPrompt: "A" },
      ],
    });
    await seedRun(); // another launch, not in the group
    const group = await listGroupRuns(db, groupId);
    expect(group.map((r) => r.id).sort()).toEqual(runs.map((r) => r.id).sort());
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
