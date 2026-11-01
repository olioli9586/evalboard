import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { getRun, isUuid, runSummary } from "@/lib/store";

export const runtime = "nodejs";

// Status and score of one run, for polling while it runs. The id is the
// share key: a random UUID nobody can guess.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Run not found." }, { status: 404 });
  try {
    const db = getPool();
    const run = await getRun(db, id);
    if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
    return Response.json({ run, summary: await runSummary(db, id) });
  } catch (err) {
    console.error("[runs] read failed:", err);
    return Response.json({ error: "Could not load the run." }, { status: 500 });
  }
}
