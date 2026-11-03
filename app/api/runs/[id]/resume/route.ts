import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { adminAccess } from "@/lib/limits";
import { enqueueBatch } from "@/lib/queue";
import { finishRun, getRun, reopenRun, type Run } from "@/lib/store";
import { isUuid } from "@/lib/uuid";
import { STUCK_AFTER_MINUTES } from "@/lib/worker";

export const runtime = "nodejs";

// Admin only: restarts a run whose chain of batches is gone, either failed or
// stuck with no activity for STUCK_AFTER_MINUTES. The new chain has its own
// id, and the worker only runs cases that have no result yet, so cases that
// finished before the restart are kept as they are and never run twice.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (adminAccess(req.headers.get("authorization")) !== "admin") {
    return Response.json({ error: "Admin token required." }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Run not found." }, { status: 404 });

  let db: ReturnType<typeof getPool>;
  let run: Run | null;
  try {
    db = getPool();
    run = await reopenRun(db, id, new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000));
    if (!run) {
      const current = await getRun(db, id);
      if (!current) return Response.json({ error: "Run not found." }, { status: 404 });
      const error =
        current.status === "succeeded"
          ? "The run already finished."
          : `The run is still making progress. A run can be resumed after ${STUCK_AFTER_MINUTES} minutes without activity.`;
      return Response.json({ error }, { status: 409 });
    }
  } catch (err) {
    console.error("[runs] resume failed:", err);
    return Response.json({ error: "Could not resume the run." }, { status: 500 });
  }

  try {
    await enqueueBatch({ runId: run.id, seq: 0, chain: randomUUID() });
  } catch (err) {
    console.error("[runs] enqueue failed:", err);
    await finishRun(db, run.id, "failed", "Could not queue the run.").catch((e) =>
      console.error("[runs] could not mark the run failed:", e),
    );
    return Response.json({ error: "Could not queue the run. Try again." }, { status: 502 });
  }
  return Response.json({ run: { id: run.id, status: run.status, resumedAt: run.resumedAt } }, { status: 202 });
}
