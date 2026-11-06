import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type pg from "pg";
import { insertResult, pendingCases } from "@/lib/store";
import { closeTestPool, freshDb, testPool } from "@/lib/test-db";

// The routes run against the test database, and the queue is a spy.
const getPool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPool,
}));
const enqueueBatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queue", () => ({ enqueueBatch }));

const { GET: LIST, POST } = await import("./route");
const { GET } = await import("./[id]/route");

let db: pg.Pool;
beforeEach(async () => {
  db = await freshDb();
  getPool.mockReset().mockImplementation(() => testPool());
  enqueueBatch.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "admin-secret");
  vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "10");
  vi.stubEnv("DAILY_SPEND_CAP_USD", "5");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(closeTestPool);

const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ input: `ticket ${i}`, expected: "billing" }));

const base = {
  name: "Support ticket triage",
  source: "sample",
  grader: "exact",
  cases: cases(2),
  models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  prompts: [{ system: "Classify the ticket." }],
};

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req as unknown as NextRequest);
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/runs/${id}`) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  });
}

function list(query: string): Promise<Response> {
  return LIST(new Request(`http://localhost/api/runs${query}`) as unknown as NextRequest);
}

const count = async (table: string) => (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n;

describe("POST /api/runs", () => {
  it("creates one queued run per model and enqueues each", async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r: { model: string }) => r.model)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
    expect(body.runs.every((r: { status: string }) => r.status === "queued")).toBe(true);

    const { rows } = await db.query("select group_id, total_cases from runs");
    expect(new Set(rows.map((r) => r.group_id))).toEqual(new Set([body.groupId]));
    expect(rows.every((r) => r.total_cases === 2)).toBe(true);
    expect(enqueueBatch.mock.calls.map((c) => c[0])).toEqual(body.runs.map((r: { id: string }) => ({ runId: r.id, seq: 0 })));
    // 2 cases x 2 runs taken from the IP's daily budget.
    expect((await db.query("select cases from usage_daily where ip = '9.9.9.9'")).rows[0].cases).toBe(4);
  });

  it("makes a prompt A/B into one run per prompt", async () => {
    const res = await post({
      ...base,
      models: ["claude-haiku-4-5"],
      prompts: [{ system: "A", label: "terse" }, { system: "B", label: "verbose" }],
    });
    expect(res.status).toBe(201);
    const { rows } = await db.query("select system_prompt, prompt_label from runs order by prompt_label");
    expect(rows).toEqual([
      { system_prompt: "A", prompt_label: "terse" },
      { system_prompt: "B", prompt_label: "verbose" },
    ]);
  });

  it("stores the launch's effort level on every run", async () => {
    const res = await post({ ...base, models: ["claude-haiku-5-5", "claude-opus-5-5"], effort: "low" });
    expect(res.status).toBe(201);
    expect((await res.json()).runs.map((r: { effort: string }) => r.effort)).toEqual(["low", "low"]);
    expect((await db.query("select effort from runs")).rows).toEqual([{ effort: "low" }, { effort: "low" }]);

    const none = await post({ ...base, name: "No effort" });
    expect((await none.json()).runs.map((r: { effort: string | null }) => r.effort)).toEqual([null, null]);
  });

  it("reuses the stored dataset when the same cases come back", async () => {
    vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "100");
    const a = await (await post(base)).json();
    const b = await (await post({ ...base, name: "Renamed" })).json();
    expect(b.datasetId).toBe(a.datasetId);
    expect(await count("datasets")).toBe(1);
    expect(await count("cases")).toBe(2);
    expect(await count("runs")).toBe(4);
  });

  it("rejects bad input before touching the database", async () => {
    expect((await post("{nope")).status).toBe(400);
    const res = await post({ ...base, models: ["gpt-4"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown model/);
    expect(await count("runs")).toBe(0);
    expect(enqueueBatch).not.toHaveBeenCalled();
  });

  it("caps public runs at 20 cases and lets the admin token go higher", async () => {
    vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "1000");
    const big = { ...base, models: ["claude-haiku-4-5"], cases: cases(250) };
    const pub = await post(big);
    expect(pub.status).toBe(400);
    expect((await pub.json()).error).toMatch(/At most 20 cases/);

    const admin = await post(big, { authorization: "Bearer admin-secret" });
    expect(admin.status).toBe(201);
    expect((await db.query("select total_cases from runs")).rows[0].total_cases).toBe(250);
  });

  it("enforces the per-IP budget all or nothing, and the admin token skips it", async () => {
    // Limit 10: 2 cases x 2 models = 4, twice, leaves 2.
    expect((await post(base)).status).toBe(201);
    expect((await post(base)).status).toBe(201);
    const over = await post(base);
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/budget/);
    // The rejected request left no dataset, runs or budget use behind.
    expect(await count("runs")).toBe(4);
    expect((await db.query("select cases from usage_daily")).rows[0].cases).toBe(8);
    // Another IP has its own budget.
    expect((await post(base, { "x-forwarded-for": "8.8.8.8" })).status).toBe(201);
    expect((await post(base, { authorization: "Bearer admin-secret" })).status).toBe(201);
  });

  it("tells a launch bigger than the whole daily budget what to cut", async () => {
    // Limit 10: 2 cases x 3 models x 2 prompts = 12.
    const res = await post({
      ...base,
      models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      prompts: [{ system: "A", label: "A" }, { system: "B", label: "B" }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "This launch is 12 case runs (2 cases × 3 models × 2 prompts). The demo allows 10 a day; use fewer cases, models or prompts.",
    );
    expect(await count("usage_daily")).toBe(0);
  });

  it("returns 401 for a wrong admin token", async () => {
    const res = await post(base, { authorization: "Bearer guess" });
    expect(res.status).toBe(401);
    expect(await count("runs")).toBe(0);
  });

  it("refuses new runs once the daily spend cap is used up", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "0");
    const res = await post(base, { authorization: "Bearer admin-secret" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/daily spend cap/);
    expect(await count("runs")).toBe(0);
  });

  it("fails a run whose queue message could not be sent", async () => {
    enqueueBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("queue unavailable"));
    const res = await post(base);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/Could not queue/);
    expect(body.runs.map((r: { status: string }) => r.status)).toEqual(["queued", "failed"]);
    const { rows } = await db.query("select status, error from runs where status = 'failed'");
    expect(rows).toEqual([{ status: "failed", error: "Could not queue the run." }]);
  });

  it("answers a database failure with a JSON 500", async () => {
    getPool.mockImplementationOnce(() => {
      throw new Error("DATABASE_URL is not configured.");
    });
    const res = await post(base);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not save the run." });
  });

  it("returns 500 without an API key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await post(base)).status).toBe(500);
  });
});

describe("GET /api/runs/[id]", () => {
  it("returns the run, its score so far and the results by position", async () => {
    const { runs } = await (await post(base)).json();
    const res = await get(runs[0].id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: runs[0].id, status: "queued", totalCases: 2 });
    expect(body.summary).toMatchObject({ done: 0, passed: 0 });
    expect(body.results).toEqual([]);

    const [c] = await pendingCases(db, runs[0].id, 1);
    await insertResult(db, runs[0].id, c.id, { error: "refused" });
    const after = await (await get(runs[0].id)).json();
    expect(after.summary).toMatchObject({ done: 1, errored: 1 });
    expect(after.results).toMatchObject([{ position: 0, pass: null, error: "refused" }]);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await get("1; drop table runs")).status).toBe(404);
  });

  it("answers a database failure with a JSON 500", async () => {
    getPool.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const res = await get(crypto.randomUUID());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not load the run." });
  });
});

describe("GET /api/runs?ids=", () => {
  it("returns the scores of the runs asked for, newest first", async () => {
    vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "100");
    const a = await (await post(base)).json();
    const b = await (await post({ ...base, models: ["claude-haiku-4-5"] })).json();
    const ids = [...a.runs, ...b.runs].map((r: { id: string }) => r.id);
    const res = await list(`?ids=${ids.join(",")},${crypto.randomUUID()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(3);
    expect(body.runs[0]).toMatchObject({ datasetName: "Support ticket triage", summary: { done: 0 } });
    expect(new Set(body.runs.map((r: { id: string }) => r.id))).toEqual(new Set(ids));
  });

  it("answers an empty list without a query and rejects bad or too many ids", async () => {
    expect(await (await list("")).json()).toEqual({ runs: [] });
    expect((await list("?ids=1;drop")).status).toBe(400);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID()).join(",");
    expect((await list(`?ids=${many}`)).status).toBe(400);
  });

  it("answers a database failure with a JSON 500", async () => {
    getPool.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });
    const res = await list(`?ids=${crypto.randomUUID()}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not load the runs." });
  });
});
