import Anthropic from "@anthropic-ai/sdk";
import { getPool } from "./db";
import { dailySpendCapUsd } from "./limits";
import { enqueueBatch } from "./queue";
import { WORKER_RETRY } from "./retry";
import { runCase } from "./run-case";
import type { WorkerDeps } from "./worker";

// The worker's real dependencies, shared by the queue consumer route and the
// inline queue used in local development.
export function workerDeps(): WorkerDeps {
  // maxRetries: 0 leaves retrying to lib/retry.ts, which counts attempts.
  // The timeout leaves room for a 4,096-token answer from a slow model, and
  // a case's model call plus its judge call (240 s at most, as timeouts are
  // not retried) still fits in the 300 s function.
  const client = new Anthropic({ maxRetries: 0, timeout: 120_000 });
  return {
    db: getPool(),
    runCase: (req) => runCase(client, req, WORKER_RETRY),
    enqueue: enqueueBatch,
    dailyCapUsd: dailySpendCapUsd(),
  };
}
