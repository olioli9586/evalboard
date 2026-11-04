# EvalBoard — LLM Evaluation Bench

Run a dataset against multiple Claude models, grade every output — exact match or
LLM-as-judge — and compare **accuracy, latency, and cost** side by side. Eval
literacy is the difference between "I built with LLMs" and "I watched tutorials";
this is the tool I use to prove which model/prompt combination actually works.

**Live demo:** https://evalboard-zeta.vercel.app (per-visitor daily case budget)

![EvalBoard](docs/home.png)

## How it works

```
Browser ── POST /api/runs ──▶ one transaction: per-IP budget, dataset, one queued
   │                          run per model x prompt ──▶ enqueue {runId, seq: 0}
   │                                                         │
   │        Vercel Queues (eval-batches) ──▶ /api/queues/eval-batch, one batch per delivery:
   │           · the next 5 cases with no result row, run concurrently
   │           · each case: target model completes it, then the grader scores it
   │             (exact: normalized string equality · judge: Opus 5.5 verdict, strict JSON schema)
   │           · each result is insert-once on (run_id, case_id)
   │           · then finish the run, or enqueue {runId, seq + 1}
   │
   └── polls GET /api/runs/[id] every 2 s ──▶ status, score, per-case results (Postgres)
```

- **Models**: Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5, plus the previous
  generation (Haiku 4.5, Sonnet 4.6, Opus 4.8) for comparing a model with
  its successor. Up to 3 per launch.
- **Datasets**: two built-in samples (classification with exact match; extraction
  with LLM judge) or paste your own as `input | expected` lines.
- **The readout**: per-model scorecards — pass rate, one bubble per case (click to
  inspect), average latency, total cost. Runs live on the server, so closing the
  tab doesn't stop them.
- **Share links**: `/runs/[id]` shows a run with every case's output and
  verdict, and updates itself while the run is in progress.
- **Regression view**: `/diff?a=..&b=..` compares two runs of the same dataset
  case by case: what got fixed, what regressed, and both answers side by side.
- **History**: the browser keeps the ids of the runs it launched; scores come
  from the server. History saved by the first version (in localStorage) is
  moved to the server once, on first load.
- **Export**: full run as JSON.

## Design decisions

- **LLM-as-judge with a structured verdict.** The judge returns
  `{pass, reasoning}` constrained by a strict JSON schema (`output_config.format`),
  so grades always parse. Reasoning is stored, not discarded — you can audit why
  a case failed.
- **Exact match is normalized** (case, trailing punctuation) — classification
  evals shouldn't fail on "Billing." vs "billing".
- **Queue-driven worker instead of one long request.** A run is a chain of
  short batches, so it can take longer than the 300 s function limit, and a
  batch that dies halfway is redelivered and redoes only its missing cases.
  Results are insert-once on `(run_id, case_id)`, so a retry can never count a
  case twice. Each model call retries 429 / 5xx / dropped connections up to 4
  attempts (exponential backoff, full jitter, honoring `retry-after`); a batch
  that still fails goes back to the queue (15 s doubling to 5 min, given up
  after 8 deliveries). If the instance dies mid-batch, the batch's 60 s lease
  runs out and the queue redelivers it.
- **Stuck runs can be restarted.** A run whose chain of batches is gone (its
  deployment was deleted, or the message expired) shows no progress.
  `POST /api/runs/[id]/resume` (admin token) restarts a failed run, or one
  idle for 15 minutes, under a new chain id. Only the missing cases run; one
  conditional `UPDATE` makes a second resume at the same time a no-op.
- **Share ids are the access control.** Run ids are random UUIDs and there is
  no endpoint that lists everyone's runs; share pages are `noindex`.
- **Cost is a first-class metric.** Every result carries token counts and a
  dollar figure computed from a price table; the scorecard totals them. Model
  choice is an economics question, not just an accuracy question.
- **Effort is a launch setting.** The 5.5 models think before answering when
  they judge it useful, and effort (low to max) sets how much. A launch can
  pick one level for all its runs, or leave each model at its default; the
  level is stored on the run and shown wherever the run is. Thinking is billed
  as output and shows up in the cost, and `max_tokens` is 4,096 so it can't
  crowd out the answer.
- **Refusals are results.** A case the model declines is recorded as errored,
  with the reason. The API's refusal fallback (another model answers instead)
  is left off: it would put a different model's answer in this model's score.
- **Model fallback**: if a requested model returns 404 (retired), the case
  transparently reruns on `claude-opus-5-5` and the result records which model
  actually served it.
- **Demo guardrails**: per-IP daily case budget and a global daily spend cap,
  both in Postgres so they hold across serverless instances; case and input
  length caps.

## Run locally

You need Postgres (any version from 14 on; for example
`docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=evalboard -p 5432:5432 postgres:17`).

```bash
npm install
cat > .env.local <<'ENV'
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgres://postgres:postgres@localhost:5432/evalboard
EVALBOARD_QUEUE=inline
ENV
npm run db:migrate
npm run dev
```

`EVALBOARD_QUEUE=inline` runs the batches inside the dev server instead of
Vercel Queues, with the same worker code and retry delays, so no Vercel
project is needed. It refuses to run in production. Without it, runs go
through Vercel Queues, which needs `vercel link` and `vercel env pull`.

Schema lives in `db/migrations/*.sql` (plain SQL, applied in order, each in a
transaction, checksummed in `schema_migrations`). `npm run db:migrate` applies
pending migrations to `DATABASE_URL`.

| Env var | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required |
| `DATABASE_URL` | none | Postgres connection string (Neon in production) |
| `EVALBOARD_QUEUE` | Vercel Queues | `inline` runs batches in the dev server (development only) |
| `EVALBOARD_JUDGE_MODEL` | `claude-opus-5-5` | Model used by the LLM judge |
| `DAILY_SPEND_CAP_USD` | `5` | Model + judge spend per day across everyone; checked before each batch |
| `DEMO_DAILY_CASE_LIMIT` | `60` | Cases x runs per IP per day for public requests |
| `EVALBOARD_ADMIN_TOKEN` | none | `Authorization: Bearer <token>` lifts the 20-case cap to 1,000, skips the per-IP budget (the spend cap still applies), and allows resuming stuck runs |

### Banking77 run

`node scripts/banking77.mts > run.json` builds a request with 250 messages
from the [Banking77](https://huggingface.co/datasets/PolyAI/banking77) test
split (CC BY 4.0; 77 intents, graded by exact match). The cases are fetched
from Hugging Face, not stored here, and a fixed seed picks the same ones
every time (`--cases`, `--seed`, `--models` change that). Send it with the
admin token:

```bash
curl -X POST "$URL/api/runs" -H "Authorization: Bearer $EVALBOARD_ADMIN_TOKEN" \
  -H "content-type: application/json" --data @run.json
```

### Tests

`npm test` runs the unit tests (Vitest). The Anthropic client is stubbed, so
no API key is needed and no calls are billed.

`npm run test:db` runs the Postgres integration tests against
`TEST_DATABASE_URL`. They wipe that database's `public` schema, so the database
name must contain `test`:

```bash
docker run -d --name evalboard-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=evalboard_test -p 54329:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/evalboard_test npm run test:db
```

CI runs both suites; the DB job uses a Postgres 17 service container.

## Tech

Next.js 16 (App Router) · TypeScript · Tailwind CSS · Anthropic SDK · Postgres (`pg`, plain SQL migrations) · Vercel Queues · Vercel

## Roadmap

- [x] Persist runs to Postgres and diff two runs (regression view)
- [ ] Prompt variants: A/B two system prompts on the same dataset
- [ ] CSV dataset upload
- [ ] Statistical significance hints for small datasets
