import { send } from "@vercel/queue";

// ---------------------------------------------------------------------------
// The worker's only link to the queue. Each message says "process the next
// batch of this run"; the worker sends the following one when it finishes.
// Tests pass their own Enqueue, and moving to another queue (QStash, Inngest)
// means rewriting this file and the consumer route, nothing else.
// ---------------------------------------------------------------------------

export const RUN_TOPIC = "eval-batches";

export interface BatchMessage {
  runId: string;
  seq: number; // step in the run's chain of batches; part of the idempotency key
}

export type Enqueue = (msg: BatchMessage) => Promise<void>;

// If a batch is delivered twice, both copies send the same next step with the
// same key, and the queue delivers it only once, so a run never ends up with
// two chains of batches.
export const enqueueBatch: Enqueue = async (msg) => {
  await send(RUN_TOPIC, msg, { idempotencyKey: `${msg.runId}:${msg.seq}` });
};
