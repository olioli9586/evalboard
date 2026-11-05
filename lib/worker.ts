import type { Db } from "./db";
import { BATCH_SIZE, type CaseResult } from "./eval";
import type { BatchMessage, Enqueue } from "./queue";
import { CaseError, type CaseRequest } from "./run-case";
import { finishRun, insertResult, markRunning, noteRunError, pendingCases, spentTodayUsd } from "./store";
import { isUuid } from "./uuid";

// ---------------------------------------------------------------------------
// The queue worker. One delivery = one batch of a run's missing cases, run
// concurrently and written as they finish; then the worker either finishes
// the run or enqueues the next batch. No single function call has to outlive
// the whole run, which is how a run gets past the 300 s function limit.
//
// Crash safety comes from the database, not the queue: results are
// insert-once on (run_id, case_id) and each batch asks which cases still have
// no result. A delivery that dies halfway is redelivered and only redoes the
// cases it hadn't written yet; a duplicate delivery can't count a case twice.
// ---------------------------------------------------------------------------

// The trigger's maxDeliveries in vercel.json (12) is a backstop above this,
// for when the worker can't reach the database to fail the run itself.
export const MAX_DELIVERIES = 8;

// A run with no activity for this long has lost its chain of batches (its
// message expired, or the deployment that sent it was deleted), and an admin
// may restart it. Every delivery counts as activity, and the longest gap
// between two is the 5 min retry wait (queueRetry never waits longer) plus a
// delivery running up to the 300 s function limit.
export const STUCK_AFTER_MINUTES = 15;

export interface WorkerDeps {
  db: Db;
  runCase: (req: CaseRequest) => Promise<{ result: CaseResult; attempts: number }>;
  enqueue: Enqueue;
  dailyCapUsd: number;
  batchSize?: number;
}

// Thrown to make the queue redeliver the batch later, after the API's
// retry-after when it sent one.
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly afterSeconds?: number,
  ) {
    super(message);
    this.name = "RetryLaterError";
  }
}

export type BatchOutcome = "skipped" | "next" | "finished";

export async function processBatch(
  deps: WorkerDeps,
  msg: BatchMessage,
  deliveryCount: number,
): Promise<BatchOutcome> {
  const { db } = deps;
  // A malformed message would fail the same way on every redelivery until it
  // expires; acknowledge it and move on.
  if (!isUuid(msg?.runId) || !Number.isInteger(msg.seq) || (msg.chain !== undefined && !isUuid(msg.chain))) {
    return "skipped";
  }
  // A late or duplicate message for a run that already finished does nothing.
  const run = await markRunning(db, msg.runId);
  if (!run) return "skipped";

  if (deliveryCount > MAX_DELIVERIES) {
    await finishRun(db, run.id, "failed", `Gave up after ${MAX_DELIVERIES} failed attempts. Last error: ${run.error ?? "unknown"}`);
    return "finished";
  }

  // Checked per batch, so the cap can be overshot by one batch per run in
  // flight at that moment.
  const spent = await spentTodayUsd(db);
  if (spent >= deps.dailyCapUsd) {
    await finishRun(db, run.id, "failed", `Daily spend cap of $${deps.dailyCapUsd} reached. Try again tomorrow.`);
    return "finished";
  }

  const cases = await pendingCases(db, run.id, deps.batchSize ?? BATCH_SIZE);
  if (cases.length === 0) {
    await finishRun(db, run.id, "succeeded");
    return "finished";
  }

  const outcomes = await Promise.allSettled(
    cases.map(async (c) => {
      try {
        const { result, attempts } = await deps.runCase({
          model: run.model,
          system: run.systemPrompt,
          input: c.input,
          expected: c.expected,
          grader: run.grader,
          effort: run.effort,
        });
        await insertResult(db, run.id, c.id, result, attempts);
      } catch (err) {
        // A failure that would repeat is the case's result; anything else
        // (rate limit after retries, outage, database error) is retried later.
        if (err instanceof CaseError && !err.retryable) {
          await insertResult(db, run.id, c.id, { error: err.message, cost_usd: err.costUsd }, err.attempts);
          return;
        }
        throw err;
      }
    }),
  );

  // Results that did finish are already written. Throwing without enqueuing
  // the next batch makes the queue redeliver this one, which then picks up
  // only the cases that are still missing.
  const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
  if (failures.length > 0) {
    const first = failures[0];
    const message = `${failures.length} of ${cases.length} cases will be retried: ${first instanceof Error ? first.message : String(first)}`;
    await noteRunError(db, run.id, message);
    const waits = failures.map((f) => (f instanceof CaseError ? f.retryAfterMs : undefined) ?? 0);
    const afterSeconds = Math.ceil(Math.max(...waits) / 1000);
    throw new RetryLaterError(message, afterSeconds || undefined);
  }

  if ((await pendingCases(db, run.id, 1)).length === 0) {
    await finishRun(db, run.id, "succeeded");
    return "finished";
  }
  // Enqueued last: if this call dies before here, the redelivered message
  // carries the run forward instead.
  await deps.enqueue({ runId: run.id, seq: msg.seq + 1, ...(msg.chain && { chain: msg.chain }) });
  return "next";
}

// The queue's backoff between redeliveries of a failed batch: 15 s doubling
// to a 5 min ceiling, or the API's retry-after when that is longer, up to the
// same ceiling. That rides out a short API outage; the ninth delivery, about
// 23 minutes after the first, fails the run (see processBatch, where the
// database is at hand; this hook is synchronous). The ceiling is what lets
// STUCK_AFTER_MINUTES tell a retrying run from a lost one.
const MAX_RETRY_WAIT_SECONDS = 300;

export function queueRetry(error: unknown, meta: { deliveryCount: number }): { afterSeconds: number } {
  const backoff = 15 * 2 ** (meta.deliveryCount - 1);
  const hinted = error instanceof RetryLaterError ? (error.afterSeconds ?? 0) : 0;
  return { afterSeconds: Math.min(MAX_RETRY_WAIT_SECONDS, Math.max(backoff, hinted)) };
}
