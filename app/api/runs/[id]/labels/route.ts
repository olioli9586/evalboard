import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { adminAccess } from "@/lib/limits";
import { getRun, setHumanLabel } from "@/lib/store";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";

// Admin only: saves a hand label for one case of an LLM-judge run, or clears
// it with pass: null. Body: { position, pass }. The run page compares these
// labels with the judge's verdicts.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (adminAccess(req.headers.get("authorization")) !== "admin") {
    return Response.json({ error: "Admin token required." }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "Run not found." }, { status: 404 });

  let body: { position?: unknown; pass?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "The body must be JSON." }, { status: 400 });
  }
  const { position, pass } = body ?? {};
  if (!Number.isInteger(position) || (position as number) < 0 || !(typeof pass === "boolean" || pass === null)) {
    return Response.json({ error: "Send { position, pass } with a case position and true, false or null." }, { status: 400 });
  }

  try {
    const db = getPool();
    const run = await getRun(db, id);
    if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
    if (run.grader !== "judge") {
      return Response.json({ error: "Only LLM-judge runs take hand labels." }, { status: 400 });
    }
    if (!(await setHumanLabel(db, id, position as number, pass))) {
      return Response.json({ error: "That case has no graded result to label." }, { status: 404 });
    }
    return Response.json({ position, humanPass: pass });
  } catch (err) {
    console.error("[runs] label failed:", err);
    return Response.json({ error: "Could not save the label." }, { status: 500 });
  }
}
