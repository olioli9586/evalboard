import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type pg from "pg";
import { createRuns, finishRun, getRun, markRunning, upsertDataset } from "@/lib/store";
import { closeTestPool, freshDb, testPool } from "@/lib/test-db";

// The route runs against the test database, and the queue is a spy.
const getPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool,
}));
const enqueueBatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queue", () => ({ enqueueBatch }));

const { POST } = await import("./route");

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
  getPool.mockReset().mockImplementation(() => testPool());
  enqueueBatch.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "admin-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(closeTestPool);

const ADMIN = { authorization: "Bearer admin-secret" };

async function seedRun() {
  const ds = await upsertDataset(db, {
    name: "triage",
    source: "custom",
    cases: [{ input: "charged twice", expected: "billing" }],
  });
  const [run] = await createRuns(db, {
    datasetId: ds.id,
    groupId: randomUUID(),
    grader: "exact",
    totalCases: 1,
    variants: [{ model: "claude-haiku-4-5", systemPrompt: "Classify." }],
  });
  return run;
}

function resume(id: string, headers: Record<string, string> = ADMIN): Promise<Response> {
  const req = new Request(`http://localhost/api/runs/${id}/resume`, { method: "POST", headers });
  return POST(req as unknown as NextRequest, { params: Promise.resolve({ id }) });
}

describe("POST /api/runs/[id]/resume", () => {
  it("restarts a failed run on a new chain", async () => {
    const run = await seedRun();
    await finishRun(db, run.id, "failed", "Gave up after 8 failed attempts.");
    const res = await resume(run.id);
    expect(res.status).toBe(202);
    expect((await res.json()).run).toMatchObject({ id: run.id, status: "running" });

    expect(enqueueBatch).toHaveBeenCalledTimes(1);
    const msg = enqueueBatch.mock.calls[0][0];
    expect(msg).toEqual({ runId: run.id, seq: 0, chain: expect.any(String) });
    expect(msg.chain).not.toBe(run.id);
    expect(await getRun(db, run.id)).toMatchObject({ status: "running", error: null });

    // A second resume right away would start a second chain.
    expect((await resume(run.id)).status).toBe(409);
    expect(enqueueBatch).toHaveBeenCalledTimes(1);
  });

  it("refuses a run that is still making progress or already succeeded", async () => {
    const running = await seedRun();
    await markRunning(db, running.id);
    const res = await resume(running.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/still making progress/);

    await finishRun(db, running.id, "succeeded");
    const done = await resume(running.id);
    expect(done.status).toBe(409);
    expect((await done.json()).error).toMatch(/already finished/);
    expect(enqueueBatch).not.toHaveBeenCalled();
  });

  it("needs the admin token", async () => {
    const run = await seedRun();
    await finishRun(db, run.id, "failed", "x");
    expect((await resume(run.id, {})).status).toBe(401);
    expect((await resume(run.id, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await getRun(db, run.id))?.status).toBe("failed");
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await resume(randomUUID())).status).toBe(404);
    expect((await resume("not-a-uuid")).status).toBe(404);
  });

  it("marks the run failed again when the queue refuses the message", async () => {
    const run = await seedRun();
    await finishRun(db, run.id, "failed", "x");
    enqueueBatch.mockRejectedValueOnce(new Error("queue down"));
    expect((await resume(run.id)).status).toBe(502);
    expect(await getRun(db, run.id)).toMatchObject({ status: "failed", error: "Could not queue the run." });
  });
});
