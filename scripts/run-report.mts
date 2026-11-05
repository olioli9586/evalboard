// Prints the numbers RESULTS.md reports, read from the database the app
// writes to (DATABASE_URL, for example from `vercel env pull`):
//
//   node --env-file=.env.preview scripts/run-report.mts <run id>...
//   node --env-file=.env.preview scripts/run-report.mts --compare <run a> <run b>
//
// Per run: rows written, score, cost, latency percentiles, how long the run
// took, the time between batches, retries, and judge vs hand-label agreement
// when the run has labels. --compare adds an exact McNemar test on the cases
// the two runs grade differently. Read-only.
import { parseArgs } from "node:util";
import pg from "pg";
import { judgeAgreement } from "../lib/agreement.ts";

const { values, positionals } = parseArgs({ options: { compare: { type: "boolean" } }, allowPositionals: true });
if (positionals.length === 0 || (values.compare && positionals.length !== 2)) {
  console.error("Usage: run-report.mts <run id>... | --compare <run a> <run b>");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const runs = await pool.query(
  `select r.id, r.model, coalesce(r.effort, 'default') as effort, r.prompt_label as prompt, d.name as dataset,
     r.grader, r.status, r.total_cases as total,
     count(res.case_id)::int as rows, count(distinct res.case_id)::int as distinct_cases,
     count(*) filter (where res.pass)::int as passed, count(res.pass)::int as graded,
     count(res.case_id) filter (where res.pass is null)::int as errored,
     round(coalesce(sum(res.cost_usd), 0), 4)::float8 as cost_usd,
     round((percentile_cont(0.5) within group (order by res.latency_ms) filter (where res.pass is not null))::numeric / 1000, 2)::float8 as p50_s,
     round((percentile_cont(0.95) within group (order by res.latency_ms) filter (where res.pass is not null))::numeric / 1000, 2)::float8 as p95_s,
     -- attempts counts the judge call too, so a judged case without retries has 2
     count(*) filter (where res.attempts > case when r.grader = 'judge' and res.pass is not null then 2 else 1 end)::int as retried,
     round(extract(epoch from r.finished_at - r.created_at), 1)::float8 as whole_run_s,
     r.resumed_at is not null as resumed
   from runs r
   join datasets d on d.id = r.dataset_id
   left join results res on res.run_id = r.id
   where r.id = any($1::uuid[])
   group by r.id, d.name
   order by r.created_at`,
  [positionals],
);
if (runs.rows.length < positionals.length) console.error(`${positionals.length - runs.rows.length} run id(s) not found.`);

// A batch's cases are written as they finish; the gap between the last
// writes of consecutive batches is the time one batch took, queue hop
// included.
const cycles = await pool.query(
  `with b as (
     select res.run_id, c.position / 5 as batch, max(res.created_at) as done_at
     from results res join cases c on c.id = res.case_id
     where res.run_id = any($1::uuid[]) group by 1, 2
   ), g as (
     select run_id, extract(epoch from done_at - lag(done_at) over (partition by run_id order by batch)) as s from b
   )
   select run_id, count(*)::int + 1 as batches,
     round((percentile_cont(0.5) within group (order by s))::numeric, 2)::float8 as cycle_p50_s,
     round(max(s)::numeric, 2)::float8 as cycle_max_s
   from g where s is not null group by run_id`,
  [positionals],
);
const cycleOf = new Map(cycles.rows.map((c) => [c.run_id, c]));

for (const r of runs.rows) {
  const c = cycleOf.get(r.id);
  console.log(`\n${r.dataset} · ${r.model} · effort ${r.effort}${r.prompt ? ` · prompt ${r.prompt}` : ""} (${r.id})`);
  console.table({
    status: r.status,
    rows: `${r.rows} for ${r.distinct_cases} cases of ${r.total}`,
    score: `${r.passed}/${r.graded} (${r.graded ? ((100 * r.passed) / r.graded).toFixed(1) : "-"}%)`,
    errored: r.errored,
    cost: `$${r.cost_usd.toFixed(4)}`,
    "latency p50 / p95": `${r.p50_s} / ${r.p95_s} s`,
    "whole run": r.whole_run_s === null ? "unfinished" : `${r.whole_run_s} s`,
    "batch cycle p50 / max": c ? `${c.cycle_p50_s} / ${c.cycle_max_s} s over ${c.batches} batches` : "-",
    "cases retried": r.retried,
    resumed: r.resumed,
  });
  if (r.grader === "judge") {
    const labels = await pool.query(`select pass, human_pass as "humanPass" from results where run_id = $1`, [r.id]);
    const a = judgeAgreement(labels.rows);
    if (a) {
      console.log(
        `Judge vs hand labels: ${a.agreed}/${a.labeled} agree, kappa ${a.kappa?.toFixed(3) ?? "undefined"}` +
          (a.ci95 ? ` (95% CI ${a.ci95[0].toFixed(2)} to ${a.ci95[1].toFixed(2)})` : "") +
          `; judge pass/hand fail ${a.judgeOnlyPass}, judge fail/hand pass ${a.humanOnlyPass}`,
      );
    }
  }
}

if (values.compare) {
  const [a, b] = positionals;
  const { rows } = await pool.query(
    `select count(*) filter (where x.pass and not y.pass)::int as only_a,
       count(*) filter (where not x.pass and y.pass)::int as only_b,
       count(*)::int as both_graded
     from results x join results y on y.case_id = x.case_id
     where x.run_id = $1 and y.run_id = $2 and x.pass is not null and y.pass is not null`,
    [a, b],
  );
  const { only_a, only_b, both_graded } = rows[0];
  console.log(`\nMcNemar on ${both_graded} cases graded in both: right only in A ${only_a}, only in B ${only_b}, p = ${mcnemar(only_a, only_b).toPrecision(2)}`);
}
await pool.end();

// Exact two-sided McNemar test: under "no difference", each disagreement is
// a fair coin flip, so p is twice the smaller binomial tail.
function mcnemar(x: number, y: number): number {
  const n = x + y;
  if (n === 0) return 1;
  let tail = 0;
  let term = 0.5 ** n; // C(n, 0) / 2^n
  for (let k = 0; k <= Math.min(x, y); k++) {
    tail += term;
    term *= (n - k) / (k + 1);
  }
  return Math.min(1, 2 * tail);
}
