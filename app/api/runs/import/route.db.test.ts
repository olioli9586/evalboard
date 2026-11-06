import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type pg from "pg";
import { SAMPLES } from "@/lib/eval";
import { listRunsById, runSummary, spentTodayUsd } from "@/lib/store";
import { closeTestPool, freshDb, testPool } from "@/lib/test-db";

const getPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool,
}));

const { POST } = await import("./route");

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
  getPool.mockReset().mockImplementation(() => testPool());
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeTestPool);

const triage = SAMPLES[0];
const inputs = triage.cases.map((c) => c.input);

function legacy(at = "2026-09-20T10:00:00.000Z") {
  return {
    id: crypto.randomUUID(),
    at,
    dataset: triage.name,
    grader: "exact",
    system: triage.system,
    caseKey: JSON.stringify(inputs),
    caseCount: inputs.length,
    models: {
      "claude-haiku-4-5": { passes: inputs.map((_, i) => i !== 2), passRate: 88, avgMs: 400, cost: 0.5 },
      "claude-sonnet-4-6": { passes: inputs.map((_, i) => (i === 5 ? null : true)), passRate: 100, avgMs: 900, cost: 0.9 },
    },
  };
}

function post(body: unknown, ip = "9.9.9.9"): Promise<Response> {
  return POST(
    new Request("http://localhost/api/runs/import", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest,
  );
}

const count = async (table: string) => (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n;

describe("POST /api/runs/import", () => {
  it("stores each v1 run as finished runs, one per model, with the same scores", async () => {
    const entry = legacy();
    const res = await post({ runs: [entry] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(0);
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0].legacyId).toBe(entry.id);
    const ids = body.imported[0].runs.map((r: { id: string }) => r.id);

    const runs = await listRunsById(db, ids);
    expect(runs.map((r) => [r.model, r.status, r.importedFrom, r.datasetName])).toEqual([
      ["claude-haiku-4-5", "succeeded", entry.id, triage.name],
      ["claude-sonnet-4-6", "succeeded", entry.id, triage.name],
    ]);
    // One launch in v1, one group here; dated when it originally ran.
    expect(runs[0].groupId).toBe(runs[1].groupId);
    expect(runs[0].createdAt).toEqual(new Date(entry.at));
    const haiku = runs.find((r) => r.model === "claude-haiku-4-5")!;
    const sonnet = runs.find((r) => r.model === "claude-sonnet-4-6")!;
    expect(haiku.summary).toMatchObject({ done: 8, graded: 8, passed: 7, errored: 0 });
    expect(sonnet.summary).toMatchObject({ done: 8, graded: 7, passed: 7, errored: 1 });
    // The client's cost figures are ignored, so they can't use up the spend cap.
    expect(await spentTodayUsd(db)).toBe(0);
    expect(haiku.summary.costUsd).toBe(0);
  });

  it("lands a recognized sample on the same dataset as new runs of it", async () => {
    await post({ runs: [legacy()] });
    const { rows } = await db.query("select source, case_count from datasets");
    expect(rows).toEqual([{ source: "sample", case_count: 8 }]);
    const expected = await db.query("select expected from cases order by position");
    expect(expected.rows.map((r) => r.expected)).toEqual(triage.cases.map((c) => c.expected));
  });

  it("is a no-op the second time and returns the same run ids", async () => {
    const entries = [legacy(), legacy("2026-09-21T10:00:00.000Z")];
    const first = await (await post({ runs: entries })).json();
    // Two tabs importing at once, then a retry.
    const [second, third] = await Promise.all([post({ runs: entries }), post({ runs: entries }, "8.8.8.8")]);
    for (const res of [second, third]) {
      expect(res.status).toBe(200);
      expect((await res.json()).imported).toEqual(first.imported);
    }
    expect(await count("runs")).toBe(4);
    expect(await count("results")).toBe(4 * 8);
    expect(await count("datasets")).toBe(1);
  });

  it("writes results only onto the run's own dataset when an id comes back with other cases", async () => {
    const entry = legacy();
    const first = await (await post({ runs: [entry] })).json();
    const forged = {
      ...entry,
      caseKey: JSON.stringify(["something else"]),
      models: { "claude-haiku-4-5": { passes: [false] } },
    };
    const again = await (await post({ runs: [forged] }, "8.8.8.8")).json();
    expect(again.imported[0].runs).toEqual(first.imported[0].runs);
    const haiku = first.imported[0].runs.find((r: { model: string }) => r.model === "claude-haiku-4-5");
    expect(await runSummary(db, haiku.id)).toMatchObject({ done: 8, passed: 7 });
    expect(await count("results")).toBe(16);
  });

  it("allows two imports per IP per day and rolls back a refused one", async () => {
    expect((await post({ runs: [legacy()] })).status).toBe(200);
    expect((await post({ runs: [legacy()] })).status).toBe(200);
    const third = await post({ runs: [legacy()] });
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/Too many imports/);
    expect(await count("runs")).toBe(4);
    // The refused request didn't count against the global quota either.
    const { rows } = await db.query("select ip, cases from usage_daily order by ip");
    expect(rows).toEqual([
      { ip: "import:9.9.9.9", cases: 2 },
      { ip: "import:all", cases: 2 },
    ]);
  });

  it("answers bad input with 400 and an empty history without writing", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ runs: "x" })).status).toBe(400);
    const res = await post({ runs: [{ id: "junk" }] });
    expect(await res.json()).toEqual({ imported: [], skipped: 1 });
    expect(await count("usage_daily")).toBe(0);
  });

  it("answers a database failure with a JSON 500", async () => {
    getPool.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const res = await post({ runs: [legacy()] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not import the history." });
  });
});
