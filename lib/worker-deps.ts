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
  // maxRetries: 0 leaves retrying to lib/retry.ts, which counts attempts;
  // the timeout keeps one hung call from using up the whole function.
  const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
  return {
    db: getPool(),
    runCase: (req) => runCase(client, req, WORKER_RETRY),
    enqueue: enqueueBatch,
    dailyCapUsd: dailySpendCapUsd(),
  };
}
