import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPool, withTransaction } from "@/lib/db";
import {
  adminAccess,
  clientIp,
  dailyCaseLimit,
  dailySpendCapUsd,
  MAX_ADMIN_CASES,
  MAX_PUBLIC_CASES,
} from "@/lib/limits";
import { enqueueBatch } from "@/lib/queue";
import { parseCreateRuns } from "@/lib/run-request";
import {
  createRuns,
  finishRun,
  listRunsById,
  reserveCases,
  spentTodayUsd,
  upsertDataset,
  type Run,
} from "@/lib/store";
import { isUuid } from "@/lib/uuid";

export const runtime = "nodejs";

// Matches the history list a browser keeps (lib/history.ts).
const MAX_LIST_IDS = 100;

// Scores for a list of run ids: the history panel loads in one request
// instead of one per run. Only runs whose ids the caller already has come back.
export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").filter(Boolean))];
  if (ids.length > MAX_LIST_IDS) {
    return Response.json({ error: `At most ${MAX_LIST_IDS} ids.` }, { status: 400 });
  }
  if (!ids.every(isUuid)) {
    return Response.json({ error: "ids must be run ids." }, { status: 400 });
  }
  if (ids.length === 0) return Response.json({ runs: [] });
  try {
    return Response.json({ runs: await listRunsById(getPool(), ids) });
  } catch (err) {
    console.error("[runs] list failed:", err);
    return Response.json({ error: "Could not load the runs." }, { status: 500 });
  }
}

// Creates one queued run per model x prompt and hands each to the queue. The
// response comes back right away; the worker does the model calls.
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not configured." }, { status: 500 });
  }
  const access = adminAccess(req.headers.get("authorization"));
  if (access === "invalid") {
    return Response.json({ error: "Invalid admin token." }, { status: 401 });
  }
  const admin = access === "admin";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseCreateRuns(body, admin ? MAX_ADMIN_CASES : MAX_PUBLIC_CASES);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const cap = dailySpendCapUsd();
  const variants = parsed.models.flatMap((model) =>
    parsed.prompts.map((p) => ({ model, systemPrompt: p.system, promptLabel: p.label, effort: parsed.effort })),
  );
  // A launch bigger than the whole daily budget could never go through, so it
  // gets told what to cut instead of "budget reached".
  const caseRuns = parsed.cases.length * variants.length;
  const limit = dailyCaseLimit();
  if (!admin && caseRuns > limit) {
    return Response.json(
      {
        error: `This launch is ${caseRuns} case runs (${parsed.cases.length} cases × ${parsed.models.length} models × ${parsed.prompts.length} prompts). The demo allows ${limit} a day; use fewer cases, models or prompts.`,
      },
      { status: 400 },
    );
  }

  let db: ReturnType<typeof getPool>;
  let created: { datasetId: string; runs: Run[] } | null;
  try {
    db = getPool();
    if ((await spentTodayUsd(db)) >= cap) {
      return Response.json({ error: `The demo's daily spend cap ($${cap}) is used up. Try again tomorrow.` }, { status: 429 });
    }
    // Budget, dataset and runs commit together: a request over budget leaves
    // nothing behind, and a failed insert gives the budget back.
    created = await withTransaction(async (tx) => {
      if (!admin && !(await reserveCases(tx, clientIp(req.headers), caseRuns, limit))) {
        return null;
      }
      const dataset = await upsertDataset(tx, { name: parsed.name, source: parsed.source, cases: parsed.cases });
      const runs = await createRuns(tx, {
        datasetId: dataset.id,
        groupId: randomUUID(),
        grader: parsed.grader,
        totalCases: parsed.cases.length,
        variants,
      });
      return { datasetId: dataset.id, runs };
    }, db);
  } catch (err) {
    console.error("[runs] create failed:", err);
    return Response.json({ error: "Could not save the run." }, { status: 500 });
  }
  if (!created) {
    return Response.json({ error: "Daily demo budget reached for your IP." }, { status: 429 });
  }

  // Enqueued only after the commit, so the worker can never receive a run id
  // it can't see yet. A run whose message didn't go out is failed rather than
  // left queued forever.
  const sent = await Promise.allSettled(created.runs.map((r) => enqueueBatch({ runId: r.id, seq: 0 })));
  const runs = await Promise.all(
    created.runs.map(async (r, i) => {
      const s = sent[i];
      if (s.status === "fulfilled") return r;
      console.error("[runs] enqueue failed:", s.reason);
      await finishRun(db, r.id, "failed", "Could not queue the run.").catch((err) =>
        console.error("[runs] could not mark the run failed:", err),
      );
      return { ...r, status: "failed" as const };
    }),
  );

  const failed = runs.some((r) => r.status === "failed");
  return Response.json(
    {
      ...(failed && { error: "Could not queue every run. Try again." }),
      groupId: runs[0].groupId,
      datasetId: created.datasetId,
      runs: runs.map((r) => ({ id: r.id, model: r.model, promptLabel: r.promptLabel, effort: r.effort, status: r.status })),
    },
    { status: failed ? 502 : 201 },
  );
}
