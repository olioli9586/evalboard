import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import type pg from "pg";
import type { EvalCase } from "./eval";
import { idempotencyKey, type BatchMessage } from "./queue";
import { CaseError, type CaseRequest } from "./run-case";
import { createRuns, getRun, reopenRun, runSummary, upsertDataset } from "./store";
import { closeTestPool, freshDb } from "./test-db";
import { ERROR_CASE_FROM_DELIVERY, MAX_DELIVERIES, processBatch, queueRetry, RetryLaterError, type WorkerDeps } from "./worker";

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
});
afterAll(closeTestPool);

// 12 cases, 3 of which the fake model gets wrong: a clean run scores 9/12.
const CASES: EvalCase[] = Array.from({ length: 12 }, (_, i) => ({
  input: i % 4 === 3 ? `case ${i} (wrong)` : `case ${i}`,
  expected: `answer ${i}`,
}));

// Stand-in for the queue: remembers idempotency keys like Vercel Queues does,
// so a duplicate send is accepted but delivered once.
class MemoryQueue {
  pending: { msg: BatchMessage; deliveryCount: number }[] = [];
  sends = 0;
  private keys = new Set<string>();
  enqueue = async (msg: BatchMessage) => {
    this.sends++;
    const key = idempotencyKey(msg);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.pending.push({ msg, deliveryCount: 1 });
  };
}

// Deterministic stand-in for runCase that counts calls per input.
function fakeModel() {
  const calls = new Map<string, number>();
  const runCase = async (req: CaseRequest) => {
    calls.set(req.input, (calls.get(req.input) ?? 0) + 1);
    const output = req.input.includes("wrong") ? "nope" : req.expected;
    return {
      result: {
        output,
        pass: output === req.expected,
        reasoning: "",
        latency_ms: 10,
        input_tokens: 100,
        output_tokens: 5,
        cost_usd: 0.001,
        model_used: req.model,
      },
      attempts: 1,
    };
  };
  return { runCase, calls };
}

async function newRun(cases = CASES) {
  const ds = await upsertDataset(db, { name: "fake", source: "custom", cases });
  const [run] = await createRuns(db, {
    datasetId: ds.id,
    groupId: crypto.randomUUID(),
    grader: "exact",
    totalCases: cases.length,
    variants: [{ model: "claude-haiku-4-5", systemPrompt: "Answer." }],
  });
  return run;
}

function deps(queue: MemoryQueue, runCase: WorkerDeps["runCase"], extra: Partial<WorkerDeps> = {}): WorkerDeps {
  return { db, runCase, enqueue: queue.enqueue, dailyCapUsd: 100, batchSize: 5, ...extra };
}

// Delivers queued messages until none are left. A failed delivery goes back
// on the queue with a higher delivery count, like a real redelivery.
async function drain(queue: MemoryQueue, d: WorkerDeps) {
  let deliveries = 0;
  while (queue.pending.length > 0) {
    const item = queue.pending.shift()!;
    deliveries++;
    try {
      await processBatch(d, item.msg, item.deliveryCount);
    } catch {
      queue.pending.push({ msg: item.msg, deliveryCount: item.deliveryCount + 1 });
    }
  }
  return deliveries;
}

async function resultRows(runId: string) {
  const { rows } = await db.query<{ rows: number; distinct_cases: number }>(
    "select count(*)::int as rows, count(distinct case_id)::int as distinct_cases from results where run_id = $1",
    [runId],
  );
  return rows[0];
}

describe("processBatch", () => {
  it("runs a dataset in batches of 5 and finishes the run", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    await queue.enqueue({ runId: run.id, seq: 0 });

    expect(await drain(queue, deps(queue, runCase))).toBe(3); // 5 + 5 + 2
    const summary = await runSummary(db, run.id);
    expect(summary).toMatchObject({ done: 12, graded: 12, passed: 9, errored: 0 });
    expect(summary.costUsd).toBeCloseTo(0.012);
    expect((await getRun(db, run.id))!.status).toBe("succeeded");
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });

  it("resumes after the worker dies mid-batch with no duplicate rows and the same score", async () => {
    // Reference score from an uninterrupted run of the same dataset.
    const clean = await newRun();
    const cleanQueue = new MemoryQueue();
    await cleanQueue.enqueue({ runId: clean.id, seq: 0 });
    await drain(cleanQueue, deps(cleanQueue, fakeModel().runCase));
    const expected = await runSummary(db, clean.id);

    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    // The worker "dies" at the 8th model call (the 3rd case of batch 2): that
    // call and every later one in the delivery fail.
    let n = 0;
    let dead = false;
    const dying: WorkerDeps["runCase"] = async (req) => {
      if (++n === 8) dead = true;
      if (dead) throw new Error("worker killed");
      return runCase(req);
    };

    await queue.enqueue({ runId: run.id, seq: 0 });
    const first = queue.pending.shift()!;
    await processBatch(deps(queue, dying), first.msg, 1); // batch 1 is fine
    const second = queue.pending.shift()!;
    await expect(processBatch(deps(queue, dying), second.msg, 1)).rejects.toBeInstanceOf(RetryLaterError);

    // Cases 0-6 were written before the crash; nothing was enqueued after it.
    expect(await resultRows(run.id)).toEqual({ rows: 7, distinct_cases: 7 });
    expect(queue.pending).toEqual([]);
    const stalled = (await getRun(db, run.id))!;
    expect(stalled.status).toBe("running");
    expect(stalled.error).toMatch(/3 of 5 cases will be retried: worker killed/);

    // The queue redelivers batch 2; the worker is healthy again.
    queue.pending.push({ msg: second.msg, deliveryCount: 2 });
    await drain(queue, deps(queue, runCase));

    expect(await resultRows(run.id)).toEqual({ rows: 12, distinct_cases: 12 });
    const after = await runSummary(db, run.id);
    expect(after).toMatchObject({ done: 12, graded: expected.graded, passed: expected.passed, errored: 0 });
    expect(after.costUsd).toBeCloseTo(expected.costUsd);
    const done = (await getRun(db, run.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.error).toBeNull();
    // Cases written before the crash were not paid for twice.
    for (let i = 0; i < 7; i++) expect(calls.get(CASES[i].input)).toBe(1);
  });

  it("finishes a stuck run on a restarted chain without re-running finished cases", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    await queue.enqueue({ runId: run.id, seq: 0 });
    await processBatch(deps(queue, runCase), queue.pending.shift()!.msg, 1);
    // The message for batch 2 is lost (its deployment was deleted, say).
    queue.pending = [];
    expect(await resultRows(run.id)).toEqual({ rows: 5, distinct_cases: 5 });

    // An admin restart begins again at seq 0 under a new chain id. Without the
    // id in the key, the queue would drop these sends as repeats of chain one.
    await reopenRun(db, run.id, new Date(Date.now() + 60_000));
    const chain = crypto.randomUUID();
    await queue.enqueue({ runId: run.id, seq: 0, chain });
    const sent: BatchMessage[] = [];
    const d = deps(queue, runCase, {
      enqueue: async (msg) => {
        sent.push(msg);
        await queue.enqueue(msg);
      },
    });
    expect(await drain(queue, d)).toBe(2); // 5 + 2: only the missing cases
    expect(sent).toEqual([{ runId: run.id, seq: 1, chain }]);

    expect(await resultRows(run.id)).toEqual({ rows: 12, distinct_cases: 12 });
    expect((await getRun(db, run.id))!.status).toBe("succeeded");
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });

  it("hands the run's effort level to every model call", async () => {
    const ds = await upsertDataset(db, { name: "fake", source: "custom", cases: CASES.slice(0, 3) });
    const [run] = await createRuns(db, {
      datasetId: ds.id,
      groupId: crypto.randomUUID(),
      grader: "exact",
      totalCases: 3,
      variants: [{ model: "claude-opus-5-5", systemPrompt: "Answer.", effort: "low" }],
    });
    const queue = new MemoryQueue();
    const { runCase } = fakeModel();
    const efforts: unknown[] = [];
    await queue.enqueue({ runId: run.id, seq: 0 });
    await drain(queue, deps(queue, async (req) => (efforts.push(req.effort), runCase(req))));
    expect(efforts).toEqual(["low", "low", "low"]);
  });

  it("writes each case once when the same batch is delivered twice at the same time", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase } = fakeModel();
    const d = deps(queue, runCase);

    const msg = { runId: run.id, seq: 0 };
    await Promise.all([processBatch(d, msg, 1), processBatch(d, msg, 1)]);
    // Both copies sent seq 1; the queue keeps only one.
    expect(queue.sends).toBe(2);
    expect(queue.pending).toHaveLength(1);
    await drain(queue, d);

    expect(await resultRows(run.id)).toEqual({ rows: 12, distinct_cases: 12 });
    expect(await runSummary(db, run.id)).toMatchObject({ done: 12, passed: 9 });
  });

  it("records a failure that would repeat as an errored case and keeps going", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase } = fakeModel();
    const flaky: WorkerDeps["runCase"] = async (req) => {
      if (req.input === "case 2") {
        const cause = new BadRequestError(400, { message: "prompt is too long" }, undefined, new Headers());
        throw new CaseError(`Model call failed: ${cause.message}`, "model", 1, { cause, costUsd: 0.0004 });
      }
      return runCase(req);
    };
    await queue.enqueue({ runId: run.id, seq: 0 });
    await drain(queue, deps(queue, flaky));

    // Case 2 would have passed, so 8 of the 11 graded cases pass.
    expect(await runSummary(db, run.id)).toMatchObject({ done: 12, graded: 11, passed: 8, errored: 1 });
    const { rows } = await db.query("select error, cost_usd::float8 as cost from results where run_id = $1 and pass is null", [run.id]);
    expect(rows[0].error).toMatch(/prompt is too long/);
    expect(rows[0].cost).toBe(0.0004); // what was paid before it failed counts toward the cap
    expect((await getRun(db, run.id))!.status).toBe("succeeded");
  });

  it("hands a rate-limited batch back to the queue with the API's retry-after", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase } = fakeModel();
    const limited: WorkerDeps["runCase"] = async (req) => {
      if (req.input === "case 1") {
        const cause = new RateLimitError(429, {}, "rate limited", new Headers({ "retry-after": "42" }));
        throw new CaseError(`Model call failed: ${cause.message}`, "model", 4, { cause });
      }
      return runCase(req);
    };

    const err = await processBatch(deps(queue, limited), { runId: run.id, seq: 0 }, 1).catch((e) => e);
    expect(err).toBeInstanceOf(RetryLaterError);
    expect(err.afterSeconds).toBe(42);
    expect(queueRetry(err, { deliveryCount: 1 })).toEqual({ afterSeconds: 42 });
    // The other four cases are kept; the limited one is not marked errored.
    expect(await resultRows(run.id)).toEqual({ rows: 4, distinct_cases: 4 });

    // The redelivery takes the five lowest missing cases: 1, then 5-8.
    await processBatch(deps(queue, runCase), { runId: run.id, seq: 0 }, 2);
    expect(await resultRows(run.id)).toEqual({ rows: 9, distinct_cases: 9 });
    const { rows } = await db.query(
      "select c.input from results r join cases c on c.id = r.case_id where r.run_id = $1 and c.position = 1",
      [run.id],
    );
    expect(rows).toEqual([{ input: "case 1" }]);
  });

  it("records a case that keeps failing while its batch gets through as errored, and finishes the run", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    const stuck: WorkerDeps["runCase"] = async (req) => {
      if (req.input === "case 1") {
        calls.set(req.input, (calls.get(req.input) ?? 0) + 1);
        const cause = new RateLimitError(429, {}, "rate limited", new Headers());
        throw new CaseError(`Model call failed: ${cause.message}`, "model", 4, { cause });
      }
      return runCase(req);
    };
    await queue.enqueue({ runId: run.id, seq: 0 });
    await drain(queue, deps(queue, stuck));

    // Before, case 1 rode along in every redelivery until the run failed.
    expect(calls.get("case 1")).toBe(ERROR_CASE_FROM_DELIVERY);
    expect((await getRun(db, run.id))!.status).toBe("succeeded");
    expect(await runSummary(db, run.id)).toMatchObject({ done: 12, errored: 1 });
    const { rows } = await db.query(
      "select r.error, r.attempts from results r join cases c on c.id = r.case_id where r.run_id = $1 and c.position = 1",
      [run.id],
    );
    expect(rows).toEqual([{ error: expect.stringMatching(/^Model call failed: 429/), attempts: 4 }]);
  });

  it("keeps retrying a batch in which every case fails, as in an outage", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const down: WorkerDeps["runCase"] = async () => {
      const cause = new RateLimitError(429, {}, "rate limited", new Headers());
      throw new CaseError(`Model call failed: ${cause.message}`, "model", 4, { cause });
    };
    await expect(processBatch(deps(queue, down), { runId: run.id, seq: 0 }, ERROR_CASE_FROM_DELIVERY)).rejects.toThrow(
      RetryLaterError,
    );
    expect(await resultRows(run.id)).toEqual({ rows: 0, distinct_cases: 0 });
  });

  it("fails the run with the last error once the deliveries run out", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    const down: WorkerDeps["runCase"] = async () => {
      throw new Error("503 service unavailable");
    };
    await expect(processBatch(deps(queue, down), { runId: run.id, seq: 0 }, 1)).rejects.toThrow();

    expect(await processBatch(deps(queue, runCase), { runId: run.id, seq: 0 }, MAX_DELIVERIES + 1)).toBe("finished");
    const failed = (await getRun(db, run.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Gave up after 8 failed attempts.*503 service unavailable/);
    expect(calls.size).toBe(0);
  });

  it("stops a run at the daily spend cap", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    const d = deps(queue, runCase, { dailyCapUsd: 0.004 });
    await queue.enqueue({ runId: run.id, seq: 0 });
    await drain(queue, d);

    // Batch 1 ($0.005) ran under the cap; batch 2 saw the cap and stopped.
    expect(calls.size).toBe(5);
    const stopped = (await getRun(db, run.id))!;
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toMatch(/Daily spend cap of \$0.004 reached/);
  });

  it("ignores a late message for a run that already finished", async () => {
    const run = await newRun();
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    await queue.enqueue({ runId: run.id, seq: 0 });
    await drain(queue, deps(queue, runCase));
    calls.clear();

    expect(await processBatch(deps(queue, runCase), { runId: run.id, seq: 1 }, 1)).toBe("skipped");
    expect(calls.size).toBe(0);
    expect(queue.pending).toEqual([]);
  });
});

describe("processBatch with a malformed message", () => {
  it("acknowledges it without touching the database or the model", async () => {
    const queue = new MemoryQueue();
    const { runCase, calls } = fakeModel();
    const d = deps(queue, runCase);
    for (const msg of [{ runId: "nope", seq: 0 }, { runId: crypto.randomUUID(), seq: Number.NaN }, null]) {
      expect(await processBatch(d, msg as unknown as BatchMessage, 1)).toBe("skipped");
    }
    expect(calls.size).toBe(0);
  });
});

describe("queueRetry", () => {
  it("backs off from 15 s, doubling to a 5 minute ceiling", () => {
    const err = new Error("db down");
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => queueRetry(err, { deliveryCount: n }).afterSeconds)).toEqual([
      15, 30, 60, 120, 240, 300, 300,
    ]);
  });

  it("waits longer when the API asked for it, never shorter, and never over 5 minutes", () => {
    expect(queueRetry(new RetryLaterError("x", 200), { deliveryCount: 1 })).toEqual({ afterSeconds: 200 });
    expect(queueRetry(new RetryLaterError("x", 900), { deliveryCount: 1 })).toEqual({ afterSeconds: 300 });
    expect(queueRetry(new RetryLaterError("x", 5), { deliveryCount: 3 })).toEqual({ afterSeconds: 60 });
    expect(queueRetry(new RetryLaterError("x"), { deliveryCount: 1 })).toEqual({ afterSeconds: 15 });
  });
});
