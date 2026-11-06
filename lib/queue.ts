import { send } from "@vercel/queue";

// ---------------------------------------------------------------------------
// The worker's only link to the queue. Each message says "process the next
// batch of this run"; the worker sends the following one when it finishes.
// Tests pass their own Enqueue, local development can run batches in-process
// (lib/inline-queue.ts), and moving to another queue (QStash, Inngest) means
// rewriting this file and the consumer route, nothing else.
// ---------------------------------------------------------------------------

export const RUN_TOPIC = "eval-batches";

export interface BatchMessage {
  runId: string;
  seq: number; // step in the run's chain of batches; part of the idempotency key
  chain?: string; // set when an admin restarted the run; absent on the first chain
}

export type Enqueue = (msg: BatchMessage) => Promise<void>;

// If a batch is delivered twice, both copies send the same next step with the
// same key, and the queue delivers it only once, so a run never ends up with
// two chains of batches. A restarted chain starts again at seq 0, so its id
// goes in the key too: otherwise the queue would drop its steps as repeats
// of the first chain's.
export function idempotencyKey(msg: BatchMessage): string {
  return msg.chain ? `${msg.runId}:${msg.chain}:${msg.seq}` : `${msg.runId}:${msg.seq}`;
}

export const enqueueBatch: Enqueue = async (msg) => {
  if (process.env.EVALBOARD_QUEUE === "inline") {
    // Loaded on demand: it imports the worker, which imports this file.
    const { deliverInline } = await import("./inline-queue");
    deliverInline(msg);
    return;
  }
  await send(RUN_TOPIC, msg, { idempotencyKey: idempotencyKey(msg) });
};
