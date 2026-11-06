import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type pg from "pg";
import type { GraderKind } from "@/lib/eval";
import { createRuns, insertResult, listResults, pendingCases, upsertDataset } from "@/lib/store";
import { closeTestPool, freshDb, testPool } from "@/lib/test-db";

// The route runs against the test database.
const getPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool,
}));

const { PUT } = await import("./route");

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
  getPool.mockReset().mockImplementation(() => testPool());
  vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "admin-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(closeTestPool);

const ADMIN = { authorization: "Bearer admin-secret" };

// A run with case 0 judged a pass and case 1 errored.
async function seedRun(grader: GraderKind = "judge") {
  const ds = await upsertDataset(db, {
    name: "qa",
    source: "custom",
    cases: [
      { input: "Why do veins look blue?", expected: "Blue light does not reach deep into tissue." },
      { input: "Where did fortune cookies come from?", expected: "It is unclear." },
    ],
  });
  const [run] = await createRuns(db, {
    datasetId: ds.id,
    groupId: randomUUID(),
    grader,
    totalCases: 2,
    variants: [{ model: "claude-haiku-5-5", systemPrompt: "Answer briefly." }],
  });
  const [c0, c1] = await pendingCases(db, run.id, 2);
  await insertResult(db, run.id, c0.id, {
    output: "Because of how light scatters in skin.",
    pass: true,
    reasoning: "Same point.",
    latency_ms: 100,
    input_tokens: 10,
    output_tokens: 8,
    cost_usd: 0.001,
    model_used: "claude-haiku-5-5",
  });
  await insertResult(db, run.id, c1.id, { error: "refused" });
  return run;
}

function label(id: string, body: unknown, headers: Record<string, string> = ADMIN): Promise<Response> {
  const req = new Request(`http://localhost/api/runs/${id}/labels`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PUT(req as unknown as NextRequest, { params: Promise.resolve({ id }) });
}

const humanLabels = async (runId: string) => (await listResults(db, runId)).map((r) => r.humanPass);

describe("PUT /api/runs/[id]/labels", () => {
  it("saves, changes and clears a hand label", async () => {
    const run = await seedRun();
    const res = await label(run.id, { position: 0, pass: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ position: 0, humanPass: false });
    expect(await humanLabels(run.id)).toEqual([false, null]);

    expect((await label(run.id, { position: 0, pass: true })).status).toBe(200);
    expect(await humanLabels(run.id)).toEqual([true, null]);
    expect((await label(run.id, { position: 0, pass: null })).status).toBe(200);
    expect(await humanLabels(run.id)).toEqual([null, null]);
  });

  it("needs the admin token", async () => {
    const run = await seedRun();
    expect((await label(run.id, { position: 0, pass: true }, {})).status).toBe(401);
    expect((await label(run.id, { position: 0, pass: true }, { authorization: "Bearer guess" })).status).toBe(401);
    expect(await humanLabels(run.id)).toEqual([null, null]);
  });

  it("rejects a bad body", async () => {
    const run = await seedRun();
    expect((await label(run.id, "{nope")).status).toBe(400);
    for (const body of [{ pass: true }, { position: -1, pass: true }, { position: 0.5, pass: true }, { position: 0, pass: "yes" }, { position: 0 }]) {
      expect((await label(run.id, body)).status).toBe(400);
    }
  });

  it("only labels graded cases of judge runs that exist", async () => {
    const run = await seedRun();
    const errored = await label(run.id, { position: 1, pass: true });
    expect(errored.status).toBe(404);
    expect((await errored.json()).error).toBe("That case has no graded result to label.");
    expect((await label(run.id, { position: 9, pass: true })).status).toBe(404);
    expect((await label(randomUUID(), { position: 0, pass: true })).status).toBe(404);
    expect((await label("not-a-uuid", { position: 0, pass: true })).status).toBe(404);

    const exact = await seedRun("exact");
    const res = await label(exact.id, { position: 0, pass: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Only LLM-judge runs take hand labels.");
  });

  it("answers a database failure with a JSON 500", async () => {
    getPool.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const res = await label(randomUUID(), { position: 0, pass: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not save the label." });
  });
});
