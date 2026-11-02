import type { BatchMessage } from "./queue";
import { processBatch, queueRetry, type WorkerDeps } from "./worker";
import { workerDeps } from "./worker-deps";

// ---------------------------------------------------------------------------
// EVALBOARD_QUEUE=inline: a stand-in for Vercel Queues in local development,
// so `npm run dev` works without a linked Vercel project. Each batch runs in
// this process on a timer, a failed batch comes back after queueRetry's
// delay, and the worker code is the same one the real queue calls.
//
// Development only: on a serverless platform the function can be frozen once
// its response is sent, which would strand the run halfway.
// ---------------------------------------------------------------------------

export function deliverInline(msg: BatchMessage, deps?: WorkerDeps, deliveryCount = 1, delayMs = 0): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("EVALBOARD_QUEUE=inline is for local development only.");
  }
  setTimeout(async () => {
    try {
      await processBatch(deps ?? workerDeps(), msg, deliveryCount);
    } catch (err) {
      const { afterSeconds } = queueRetry(err, { deliveryCount });
      console.error(
        `[queue:inline] batch ${msg.runId}:${msg.seq} failed (delivery ${deliveryCount}), retrying in ${afterSeconds}s:`,
        err,
      );
      deliverInline(msg, deps, deliveryCount + 1, afterSeconds * 1000);
    }
  }, delayMs);
}
