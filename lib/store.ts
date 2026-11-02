import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { CaseResult, EvalCase, GraderKind } from "./eval";
import type { LegacyImport } from "./import";

// ---------------------------------------------------------------------------
// Data access for datasets, runs, and results. Every function takes the Db to
// run on, so callers choose between the pool and a transaction client, and
// tests can point it at a throwaway database.
// ---------------------------------------------------------------------------

export type DatasetSource = "sample" | "custom" | "csv" | "import";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface Run {
  id: string;
  datasetId: string;
  groupId: string;
  model: string;
  systemPrompt: string;
  promptLabel: string | null;
  grader: GraderKind;
  status: RunStatus;
  totalCases: number;
  error: string | null;
  importedFrom: string | null; // the v1 run's id, for runs copied from browser history
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface StoredCase extends EvalCase {
  id: string;
  position: number;
}

export interface RunSummary {
  done: number; // cases with a result row, graded or errored
  graded: number;
  passed: number;
  errored: number;
  avgLatencyMs: number; // over graded cases
  costUsd: number;
}

// A run as listed in history: the run, its dataset's name, and its score.
export interface RunListItem extends Run {
  datasetName: string;
  summary: RunSummary;
}

export interface Dataset {
  id: string;
  name: string;
  source: DatasetSource;
  caseCount: number;
  createdAt: Date;
}

// One result row, keyed by the case's position in its dataset.
export interface ResultRow {
  position: number;
  output: string;
  pass: boolean | null;
  error: string | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  reasoning: string;
  modelUsed: string | null;
  attempts: number;
}

const RUN_COLUMNS = `
  id, dataset_id as "datasetId", group_id as "groupId", model,
  system_prompt as "systemPrompt", prompt_label as "promptLabel", grader, status,
  total_cases as "totalCases", error, imported_from as "importedFrom",
  created_at as "createdAt", started_at as "startedAt", finished_at as "finishedAt"`;

// Aggregates over one run's result rows.
const SUMMARY_COLUMNS = `
  count(*)::int as done,
  count(pass)::int as graded,
  count(*) filter (where pass)::int as passed,
  count(*) filter (where pass is null)::int as errored,
  coalesce(round(avg(latency_ms) filter (where pass is not null)), 0)::int as "avgLatencyMs",
  coalesce(sum(cost_usd), 0)::float8 as "costUsd"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres rejects a malformed uuid with an error, so ids from a URL or a
// queue message are checked before they reach a query.
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}

export function hashCases(cases: EvalCase[]): string {
  return createHash("sha256")
    .update(JSON.stringify(cases.map((c) => [c.input, c.expected])))
    .digest("hex");
}

// Returns the existing dataset when the same cases were stored before. Run it
// inside a transaction so a dataset never exists without its cases.
export async function upsertDataset(
  db: Db,
  args: { name: string; source: DatasetSource; cases: EvalCase[] },
): Promise<{ id: string; created: boolean }> {
  if (args.cases.length === 0) throw new Error("A dataset needs at least one case.");
  const hash = hashCases(args.cases);
  // Two requests storing the same cases at once: the second insert waits on
  // the unique index, then does nothing and falls through to the select.
  const inserted = await db.query<{ id: string }>(
    `insert into datasets (name, source, content_hash, case_count)
     values ($1, $2, $3, $4)
     on conflict (content_hash) do nothing
     returning id`,
    [args.name, args.source, hash, args.cases.length],
  );
  if (inserted.rows.length === 0) {
    const existing = await db.query<{ id: string }>(
      "select id from datasets where content_hash = $1",
      [hash],
    );
    return { id: existing.rows[0].id, created: false };
  }
  const id = inserted.rows[0].id;
  // One multi-row insert via unnest instead of a round trip per case.
  await db.query(
    `insert into cases (dataset_id, position, input, expected)
     select $1, t.position, t.input, t.expected
     from unnest($2::int[], $3::text[], $4::text[]) as t(position, input, expected)`,
    [id, args.cases.map((_, i) => i), args.cases.map((c) => c.input), args.cases.map((c) => c.expected)],
  );
  return { id, created: true };
}

export async function createRuns(
  db: Db,
  args: {
    datasetId: string;
    groupId: string;
    grader: GraderKind;
    totalCases: number;
    variants: { model: string; systemPrompt: string; promptLabel?: string }[];
  },
): Promise<Run[]> {
  const { rows } = await db.query<Run>(
    `insert into runs (dataset_id, group_id, grader, total_cases, model, system_prompt, prompt_label)
     select $1, $2, $3, $4, v.model, v.system_prompt, v.prompt_label
     from unnest($5::text[], $6::text[], $7::text[])
       with ordinality as v(model, system_prompt, prompt_label, n)
     order by v.n
     returning ${RUN_COLUMNS}`,
    [
      args.datasetId,
      args.groupId,
      args.grader,
      args.totalCases,
      args.variants.map((v) => v.model),
      args.variants.map((v) => v.systemPrompt),
      args.variants.map((v) => v.promptLabel ?? null),
    ],
  );
  return rows;
}

// Stores one v1 history entry as finished runs, one per model, and returns
// their ids. Run it inside a transaction. Every step is idempotent: the
// dataset dedupes by content hash, the runs by (imported_from, model), the
// results by (run_id, case_id). Importing the same entry again returns the
// runs the first import made and writes nothing.
//
// Only pass/fail is imported. v1 kept latency and cost as per-model averages,
// not per case, and a client-supplied cost would count toward today's spend
// cap; so imported rows have no latency and zero cost.
export async function importRun(db: Db, run: LegacyImport): Promise<{ id: string; model: string }[]> {
  const dataset = await upsertDataset(db, { name: run.datasetName, source: run.source, cases: run.cases });
  await db.query(
    `insert into runs (dataset_id, group_id, grader, total_cases, model, system_prompt, status,
       imported_from, created_at, started_at, finished_at)
     select $1, $2, $3, $4, m, $5, 'succeeded', $6, $7, $7, $7
     from unnest($8::text[]) as m
     on conflict (imported_from, model) where imported_from is not null do nothing`,
    [
      dataset.id,
      randomUUID(),
      run.grader,
      run.cases.length,
      run.system,
      run.legacyId,
      run.at,
      run.models.map((m) => m.model),
    ],
  );
  const rows = run.models.flatMap((m) => m.passes.map((pass, position) => ({ model: m.model, position, pass })));
  // Results join through the stored run, so they always land on that run's
  // own dataset, even if a later import of the same id sent other cases.
  await db.query(
    `insert into results (run_id, case_id, pass, error)
     select r.id, c.id, t.pass, case when t.pass is null then 'Not graded in the original run.' end
     from unnest($2::text[], $3::int[], $4::boolean[]) as t(model, position, pass)
     join runs r on r.imported_from = $1 and r.model = t.model
     join cases c on c.dataset_id = r.dataset_id and c.position = t.position
     on conflict (run_id, case_id) do nothing`,
    [run.legacyId, rows.map((r) => r.model), rows.map((r) => r.position), rows.map((r) => r.pass)],
  );
  const { rows: runs } = await db.query<{ id: string; model: string }>(
    "select id, model from runs where imported_from = $1 order by model",
    [run.legacyId],
  );
  return runs;
}

export async function getRun(db: Db, id: string): Promise<Run | null> {
  const { rows } = await db.query<Run>(`select ${RUN_COLUMNS} from runs where id = $1`, [id]);
  return rows[0] ?? null;
}

// Runs by id, newest first, each with its score. There is deliberately no
// "list all runs": a run's id is its share key, so a browser only sees the
// runs it launched or was sent a link to. Unknown ids are left out.
export async function listRunsById(db: Db, ids: string[]): Promise<RunListItem[]> {
  return listRunItems(db, "id = any($1::uuid[])", [ids]);
}

// The runs launched together with one run (other models, other prompt), so a
// run page can offer them for a diff.
export async function listGroupRuns(db: Db, groupId: string): Promise<RunListItem[]> {
  return listRunItems(db, "group_id = $1", [groupId]);
}

async function listRunItems(db: Db, where: string, params: unknown[]): Promise<RunListItem[]> {
  // The lateral subquery aggregates each run's results on their own, using
  // the (run_id, case_id) key; a run with no results still gets a row of zeros.
  const { rows } = await db.query<Run & RunSummary & { datasetName: string }>(
    `select r.*, d.name as "datasetName", s.*
     from (select ${RUN_COLUMNS} from runs where ${where}) r
     join datasets d on d.id = r."datasetId"
     cross join lateral (
       select ${SUMMARY_COLUMNS} from results where run_id = r.id
     ) s
     order by r."createdAt" desc, r.model`,
    params,
  );
  return rows.map(({ done, graded, passed, errored, avgLatencyMs, costUsd, ...run }) => ({
    ...run,
    summary: { done, graded, passed, errored, avgLatencyMs, costUsd },
  }));
}

export async function getDataset(db: Db, id: string): Promise<Dataset | null> {
  const { rows } = await db.query<Dataset>(
    `select id, name, source, case_count as "caseCount", created_at as "createdAt"
     from datasets where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listCases(db: Db, datasetId: string): Promise<StoredCase[]> {
  const { rows } = await db.query<StoredCase>(
    "select id, position, input, expected from cases where dataset_id = $1 order by position",
    [datasetId],
  );
  return rows;
}

// The results a run has so far, in dataset order. Cases still pending have no
// row; callers match rows to cases by position.
export async function listResults(db: Db, runId: string): Promise<ResultRow[]> {
  const { rows } = await db.query<ResultRow>(
    `select c.position, res.output, res.pass, res.error, res.latency_ms as "latencyMs",
       res.input_tokens as "inputTokens", res.output_tokens as "outputTokens",
       res.cost_usd::float8 as "costUsd", res.judge_reasoning as reasoning,
       res.model_used as "modelUsed", res.attempts
     from results res
     join cases c on c.id = res.case_id
     where res.run_id = $1
     order by c.position`,
    [runId],
  );
  return rows;
}

// Moves a queued run to running. started_at keeps the first start, so a
// redelivered batch doesn't reset it. Returns null for a finished run.
export async function markRunning(db: Db, id: string): Promise<Run | null> {
  const { rows } = await db.query<Run>(
    `update runs set status = 'running', started_at = coalesce(started_at, now())
     where id = $1 and status in ('queued', 'running')
     returning ${RUN_COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

// Only an unfinished run can finish, so a late duplicate batch can't flip a
// failed run to succeeded or move finished_at. Returns null if already done.
export async function finishRun(
  db: Db,
  id: string,
  status: "succeeded" | "failed",
  error: string | null = null,
): Promise<Run | null> {
  const { rows } = await db.query<Run>(
    `update runs set status = $2, error = $3, finished_at = now()
     where id = $1 and status in ('queued', 'running')
     returning ${RUN_COLUMNS}`,
    [id, status, error],
  );
  return rows[0] ?? null;
}

// Keeps the latest transient error on a running run, so its page can say why
// it is waiting and a give-up message can quote it. finishRun overwrites it.
export async function noteRunError(db: Db, id: string, error: string): Promise<void> {
  await db.query("update runs set error = $2 where id = $1 and status = 'running'", [id, error]);
}

// The next cases of a run that have no result yet, in dataset order. The
// worker asks "what's missing" instead of keeping an offset, which is what
// lets it resume correctly after a crash at any point.
export async function pendingCases(db: Db, runId: string, limit: number): Promise<StoredCase[]> {
  const { rows } = await db.query<StoredCase>(
    `select c.id, c.position, c.input, c.expected
     from runs r
     join cases c on c.dataset_id = r.dataset_id
     left join results res on res.run_id = r.id and res.case_id = c.id
     where r.id = $1 and res.case_id is null
     order by c.position
     limit $2`,
    [runId, limit],
  );
  return rows;
}

// Idempotent: the first result written for a (run, case) wins and later
// writes for the same pair are ignored. Returns whether this call wrote it.
export async function insertResult(
  db: Db,
  runId: string,
  caseId: string,
  result: CaseResult | { error: string },
  attempts = 1,
): Promise<boolean> {
  const r = "error" in result ? null : result;
  const { rowCount } = await db.query(
    `insert into results (run_id, case_id, output, pass, error, latency_ms, input_tokens,
       output_tokens, cost_usd, judge_reasoning, model_used, attempts)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (run_id, case_id) do nothing`,
    [
      runId,
      caseId,
      r?.output ?? "",
      r?.pass ?? null,
      "error" in result ? result.error : null,
      r?.latency_ms ?? null,
      r?.input_tokens ?? 0,
      r?.output_tokens ?? 0,
      r?.cost_usd ?? 0,
      r?.reasoning ?? "",
      r?.model_used ?? null,
      attempts,
    ],
  );
  return rowCount === 1;
}

export async function runSummary(db: Db, runId: string): Promise<RunSummary> {
  const { rows } = await db.query<RunSummary>(
    `select ${SUMMARY_COLUMNS} from results where run_id = $1`,
    [runId],
  );
  return rows[0];
}

// Reserves n cases of today's per-IP budget, all or nothing. The conditional
// upsert is a single statement, so concurrent requests can't both slip under
// the limit the way a read-then-write would.
export async function reserveCases(db: Db, ip: string, n: number, limit: number): Promise<boolean> {
  if (n > limit) return false;
  const { rowCount } = await db.query(
    `insert into usage_daily (ip, day, cases) values ($1, current_date, $2)
     on conflict (ip, day) do update set cases = usage_daily.cases + excluded.cases
     where usage_daily.cases + excluded.cases <= $3`,
    [ip, n, limit],
  );
  return rowCount === 1;
}

// Total model + judge spend recorded today, for the global daily cap.
export async function spentTodayUsd(db: Db): Promise<number> {
  const { rows } = await db.query<{ usd: number }>(
    "select coalesce(sum(cost_usd), 0)::float8 as usd from results where created_at >= current_date",
  );
  return rows[0].usd;
}
