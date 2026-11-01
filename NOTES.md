# EvalBoard v2 notes

Working log for PROJECTS.md item 1 (branch `evalboard-v2`). Each session ends
with what was done, what was decided and why, and the next step.

## Plan (approved 2026-10-31)

| Day | Work | Status |
|---|---|---|
| 1 | Schema, migrations, data-access layer, Postgres tests in CI | done |
| 2 | `POST /api/runs`, queue worker (Vercel Queues), retry with backoff, spend caps, kill/resume test | next |
| 3 | UI on server runs, `/runs/[id]`, `/diff`, one-time localStorage import | |
| 4 | Neon + Queues setup, preview deploy, 250-case Banking77 run, fault-injection resume, record numbers | |
| 5 | Prompt A/B, CSV upload | |
| 6 | Hand-label 50 cases, judge kappa, README, RESULTS.md, fresh-context review, PR | |

"Before" number for the resume bullet: runs were capped at 20 cases
(`MAX_CASES` in `app/page.tsx`), run from the browser.

## Day 1 (2026-10-31)

**Done**
- `db/migrations/001_init.sql`: `datasets`, `cases`, `runs`, `results`, `usage_daily`.
- `lib/migrate.mts` + `npm run db:migrate`: plain-SQL migration runner.
- `lib/db.ts`: connection pool and `withTransaction`.
- `lib/store.ts`: all the queries the worker will need.
- 15 Postgres integration tests (`npm run test:db`) plus a CI job on `postgres:17`.
- Mutation check: breaking insert-once and the budget limit on purpose made 3
  tests fail, so the tests do catch those bugs.

**Decisions and why**
- **Plain SQL + `pg`, no ORM.** The point of this item is showing SQL and schema
  design; hand-written queries are easier to explain than generated ones. `pg`
  also talks to the plain Postgres container in CI, which Neon's HTTP driver
  can't.
- **Vercel Queues over QStash/Inngest.** Already inside the Vercel project (no
  third account), first 1M operations free on Hobby, per-message idempotency
  keys, and a retry hook that sees the delivery count. Inngest's step functions
  would hide the retry and idempotency logic this project is meant to show.
  Hobby functions still max out at 300 s (checked 2026-10-31), so the "past the
  serverless limit" claim holds.
- **One run = one model x one prompt x one dataset.** A multi-model launch or a
  prompt A/B creates several runs sharing a `group_id`, so a diff always
  compares exactly two runs.
- **Primary key `(run_id, case_id)` on results, no extra `run_id` index.** The
  key is what makes retries safe, and its leftmost column already serves
  "all results for a run". A second index would only slow writes.
- **Insert-once (`ON CONFLICT DO NOTHING`), not update-on-conflict.** If two
  deliveries of the same batch race, the first finished write wins and a later
  one can never flip a pass to a fail. "Same score after resume" becomes a hard
  guarantee. Interview phrasing: idempotent insert.
- **Scores are computed from rows, never stored as counters.** A counter bumped
  per case could be bumped twice by a retry; `count(*) filter (where pass)`
  can't.
- **`pendingCases` asks "which cases have no result?" instead of keeping an
  offset.** After a crash at any point, the next delivery picks up exactly the
  missing cases.
- **Budget check is one statement:** `INSERT ... ON CONFLICT DO UPDATE ... WHERE
  cases + n <= limit`. A read-then-write would let two concurrent requests both
  pass. The test fires 25 concurrent reservations at a limit of 10 and gets
  exactly 10.
- **Migration runner:** each file in its own transaction (a failing migration
  leaves nothing half-applied), a checksum so editing an applied file is
  refused, and `pg_advisory_lock` so two deploys migrating at once take turns.
- **Test safety:** DB tests read only `TEST_DATABASE_URL`, never `DATABASE_URL`,
  and refuse a database whose name lacks "test", because each test wipes the
  schema.

**Environment note:** Docker Desktop didn't start on the Mac, so local DB tests
ran on a temporary Homebrew Postgres 14 cluster. CI runs them on Postgres 17.

**Next (Day 2):** `POST /api/runs` (validate, reserve budget, upsert dataset,
create runs, enqueue), the queue consumer (batch of 5 pending cases, insert-once,
enqueue the next batch or finish), per-call retry with exponential backoff and
jitter on 429/5xx honoring `retry-after`, a global daily USD cap plus an admin
token for big runs, and an integration test that crashes a batch halfway,
redelivers it, and checks for no duplicates and the same score.
