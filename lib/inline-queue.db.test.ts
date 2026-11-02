import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { deliverInline } from "./inline-queue";
import type { CaseRequest } from "./run-case";
import { createRuns, getRun, runSummary, upsertDataset } from "./store";
import { closeTestPool, freshDb } from "./test-db";
import type { WorkerDeps } from "./worker";

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(closeTestPool);

const CASES = Array.from({ length: 12 }, (_, i) => ({ input: `case ${i}`, expected: i % 3 ? "yes" : "no" }));

async function until(check: () => Promise<boolean>, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("deliverInline", () => {
  it("runs the batches in this process until the run finishes", async () => {
    const ds = await upsertDataset(db, { name: "fake", source: "custom", cases: CASES });
    const [run] = await createRuns(db, {
      datasetId: ds.id,
      groupId: crypto.randomUUID(),
      grader: "exact",
      totalCases: CASES.length,
      variants: [{ model: "claude-haiku-4-5", systemPrompt: "" }],
    });
    const seqs: number[] = [];
    const deps: WorkerDeps = {
      db,
      runCase: async (req: CaseRequest) => ({
        result: {
          output: "yes",
          pass: req.expected === "yes",
          reasoning: "",
          latency_ms: 5,
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: 0,
          model_used: req.model,
        },
        attempts: 1,
      }),
      enqueue: async (msg) => {
        seqs.push(msg.seq);
        deliverInline(msg, deps);
      },
      dailyCapUsd: 5,
    };

    deliverInline({ runId: run.id, seq: 0 }, deps);
    await until(async () => (await getRun(db, run.id))?.status === "succeeded");
    expect(await runSummary(db, run.id)).toMatchObject({ done: 12, passed: 8 });
    expect(seqs).toEqual([1, 2]); // 12 cases in batches of 5
  });

  it("refuses to run in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => deliverInline({ runId: crypto.randomUUID(), seq: 0 })).toThrow(/local development only/);
  });
});
