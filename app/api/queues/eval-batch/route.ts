import { handleCallback } from "@vercel/queue";
import type { BatchMessage } from "@/lib/queue";
import { processBatch, queueRetry } from "@/lib/worker";
import { workerDeps } from "@/lib/worker-deps";

// Push consumer for the eval-batches topic (registered in vercel.json). The
// message is acknowledged when the handler returns and redelivered, after
// queueRetry's delay, when it throws.

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback<BatchMessage>(
  async (msg, meta) => {
    await processBatch(workerDeps(), msg, meta.deliveryCount);
  },
  { retry: queueRetry },
);
