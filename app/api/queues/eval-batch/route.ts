import Anthropic from "@anthropic-ai/sdk";
import { handleCallback } from "@vercel/queue";
import { getPool } from "@/lib/db";
import { dailySpendCapUsd } from "@/lib/limits";
import { enqueueBatch, type BatchMessage } from "@/lib/queue";
import { WORKER_RETRY } from "@/lib/retry";
import { runCase } from "@/lib/run-case";
import { processBatch, queueRetry } from "@/lib/worker";

// Push consumer for the eval-batches topic (registered in vercel.json). The
// message is acknowledged when the handler returns and redelivered, after
// queueRetry's delay, when it throws.

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback<BatchMessage>(
  async (msg, meta) => {
    // maxRetries: 0 leaves retrying to lib/retry.ts, which counts attempts;
    // the timeout keeps one hung call from using up the whole function.
    const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
    await processBatch(
      {
        db: getPool(),
        runCase: (req) => runCase(client, req, WORKER_RETRY),
        enqueue: enqueueBatch,
        dailyCapUsd: dailySpendCapUsd(),
      },
      msg,
      meta.deliveryCount,
    );
  },
  { retry: queueRetry },
);
