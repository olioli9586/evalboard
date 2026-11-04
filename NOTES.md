# EvalBoard v2 notes

Working log for PROJECTS.md item 1 (branch `evalboard-v2`). Each session ends
with what was done, what was decided and why, and the next step.

## Plan (approved 2026-10-31)

| Day | Work | Status |
|---|---|---|
| 1 | Schema, migrations, data-access layer, Postgres tests in CI | done |
| 2 | `POST /api/runs`, queue worker (Vercel Queues), retry with backoff, spend caps, kill/resume test | done |
| 3 | UI on server runs, `/runs/[id]`, `/diff`, one-time localStorage import | done |
| 4 | Neon + Queues setup, preview deploy, 250-case Banking77 run, fault-injection resume, record numbers | done, except a run past 300 s (see Day 4) |
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

## Day 2 (2026-11-01)

**Done**
- `lib/run-case.ts`: the model call + grading moved out of the v1 route so the
  route and the worker grade the same way. The v1 route's 19 tests pass
  unchanged, which shows the move didn't change its behavior.
- `lib/retry.ts`: per-call retry (exponential backoff, full jitter,
  `retry-after`, attempts counted).
- `lib/worker.ts`: `processBatch` (one queue delivery = one batch) and
  `queueRetry` (the queue's delay between redeliveries).
- `lib/queue.ts`: `enqueueBatch`, the one function that touches
  `@vercel/queue`. `vercel.json` registers the consumer route
  `app/api/queues/eval-batch`.
- `POST /api/runs` (budget + dataset + runs in one transaction, then enqueue),
  `GET /api/runs/[id]` (status and score).
- `lib/limits.ts`: daily USD cap, per-IP case limit, admin token.
- Tests: 81 unit (was 49) and 40 Postgres (was 15). The kill/resume test
  crashes batch 2 after 2 of its 5 cases are written, redelivers it, and checks
  12 rows for 12 cases, the same score and cost as a clean run, and that the 7
  cases written before the crash were not run again.
- Self-review fixes before committing: the new routes answer database errors
  with JSON (the UI shows `error`), and the worker acknowledges a malformed
  message instead of failing on it for 24 hours of redeliveries.
- Mutation check: three bugs planted in the worker (record rate-limited cases as
  errored, reuse the same `seq` for the next batch, enqueue the next batch even
  when cases failed) each made tests fail.

**Decisions and why**
- **Two retry layers.** Each API call retries up to 4 times within the
  delivery (seconds). If that isn't enough, the batch throws and the queue
  redelivers it later (15 s doubling to 5 min, about 23 min in total). Short
  blips cost a few seconds; a real outage doesn't burn function time sleeping.
  Interview line: "retry fast in-process, retry slow through the queue".
- **Own retry instead of the SDK's built-in one** (`maxRetries: 0` on the
  worker's client). The SDK already backs off and reads `retry-after`, but (1)
  its retries are invisible, and the result row stores the attempt count; (2)
  it would sleep through a long `retry-after`, while ours gives the batch back
  to the queue when the wait is over 20 s; (3) full jitter instead of the SDK's
  25 %, so many workers hitting the same limit don't retry in lockstep.
- **Which failures get retried.** 408/409/429/5xx and dropped connections are
  retried (same list as the SDK, and `x-should-retry` wins). A 400, a refusal
  or an unreadable judge verdict would fail the same way again, so it is
  stored as an errored case (`pass` null) and the run continues.
- **The judge call retries on its own.** A judge 429 doesn't re-run the model
  call that was already paid for (tested).
- **Latency is the successful call only.** Counting backoff waits would make a
  rate-limited model look slow.
- **Next batch is enqueued last.** If a delivery dies after writing some
  results, the queue redelivers it and `pendingCases` returns only what is
  missing. Enqueuing earlier would let the run move on with holes (mutation M3
  shows the test catches that).
- **Idempotency key `runId:seq` on every send.** If one batch is delivered
  twice, both copies send `seq + 1`; Vercel Queues accepts both sends but
  delivers one, so a run never splits into two chains. Insert-once still
  protects the score if two copies overlap. Worst case: one batch paid for
  twice, never counted twice. A per-run lease would remove even that; not worth
  the extra state at this scale.
- **The give-up happens in the worker, not in `queueRetry`.** The queue's retry
  hook is synchronous and has no database. So the 9th delivery fails the run
  itself, quoting the last error that `noteRunError` kept on the run.
- **Budget, dataset and runs commit in one transaction**, and messages are sent
  after the commit. An over-budget request leaves nothing behind, and the worker
  can never get a run id it can't see yet. A run whose send fails is marked
  failed, not left queued forever.
- **Spend limits.** Public requests: 20 cases per run (the v1 cap) and 60
  case-runs per IP per day. The admin token allows 1,000 cases and skips the IP
  budget. A global `DAILY_SPEND_CAP_USD` (default $5) applies to everyone and is
  checked before every batch, so it can be overshot by at most one batch.
  Outer backstop: a monthly limit set in the Anthropic Console (Day 4).

**Known gaps (on purpose for now)**
- A run whose message is lost (for example, retention expired) stays `running`.
  Day 4: an admin re-enqueue for stuck or failed runs. It starts a new chain at
  a fresh `seq`, and `pendingCases` makes that safe.
- Cost of a failed call isn't recorded (for example, the model call before a
  judge failure), so the spend cap undercounts slightly.
- `spentTodayUsd` scans today's results on each batch. Fine at demo scale; an
  index on `results(created_at)` fixes it if it ever matters.
- Day 4 check: confirm on the preview that a forged POST to the queue route is
  rejected. Even if it isn't, it can only re-run missing cases of an existing
  unfinished run.

**Next (Day 3):** the UI launches runs through `POST /api/runs` and polls
`GET /api/runs/[id]` (needs a results list endpoint), a `/runs/[id]` share page,
a `/diff?a=&b=` page, and a one-time import of localStorage history (source
`import`). Then delete `/api/run-case` and the in-memory `rate-limit.ts`.

## Day 3 (2026-11-02)

**Done**
- `GET /api/runs/[id]` now includes the per-case results. `GET /api/runs?ids=`
  returns the scores of up to 100 runs in one query, for the history panel.
- One-time import of v1 history: `POST /api/runs/import`, and migration 002
  adds `runs.imported_from`.
- `EVALBOARD_QUEUE=inline`: `npm run dev` runs batches in-process, so local
  development needs no Vercel project.
- UI: the home page launches runs through `POST /api/runs` and polls them.
  `/runs/[id]` is the share page and refreshes itself while the run is in
  progress. `/diff?a=&b=` compares two runs case by case. Added not-found and
  error pages.
- Removed `/api/run-case` and the in-memory `lib/rate-limit.ts`. The v1
  route's grading and fallback tests moved to `lib/run-case.test.ts`, so
  `runCase` kept that coverage.
- Tests: 69 unit and 56 Postgres (were 81 and 40; the unit count dropped
  because the 19 v1 route tests and 6 rate-limit tests went away with the
  code, and 8 of them came back as `runCase` tests).
- Mutation check on the import: three planted bugs (results joined to cases
  by position alone, no conflict clause on the runs insert, a refused quota
  returning instead of rolling back) each made a test fail.
- End to end on this machine, with no API spend: a fake Anthropic server
  (`ANTHROPIC_BASE_URL`), a local Postgres and the inline queue.
  - A 20-case x 3-model run went through 4 batches per run in about 9 s. The
    fake server's 529s were absorbed by per-call retry; 10 result rows record
    2 or 3 attempts.
  - Headless Chrome (a throwaway profile):
    - v1 history seeded in localStorage was imported on first load and the
      old key removed.
    - A launch filled its 16 bubbles live, and the case detail opened.
    - Picking two runs gave a Compare link that opened the diff page.
    - A run page refreshed itself from running to finished.
  - The per-IP import limit also showed up in this test. After two curl
    imports the browser's import got a 429, and the page kept the old
    history for the next visit, as designed.

**Decisions and why**
- **No "list all runs" endpoint.** A run's id is its share key; a public list
  would show everyone's prompts and cases. The browser keeps the ids it
  launched (`evalboard-history`, max 100) and asks for their scores in one
  batch request. A lateral subquery aggregates each run's results on its own
  key, so this is one query instead of one request per run.
- **The import is idempotent through the schema, not through app logic.**
  - Datasets dedupe by content hash.
  - Runs dedupe by a unique index on `(imported_from, model)`, with
    `ON CONFLICT DO NOTHING`.
  - Results dedupe by their primary key.
  - So importing the same history twice, even from two tabs at once (tested),
    returns the same run ids and writes nothing new. It is the same
    insert-once idea as the worker.
- **Only pass/fail is imported.** v1 kept latency and cost as per-model
  averages, not per case, so filling each row with the average would invent
  per-case data. And a client-sent cost would count toward today's spend
  cap, so a forged import could use up the demo for everyone. Imported rows
  have zero cost and no latency, and the run page says so.
- **Built-in samples are recognized by their exact inputs.** That brings back
  the expected answers v1 never saved. Then the cases hash to the same dataset
  as new runs of that sample, so an old v1 run and a new v2 run can be diffed
  directly (checked in the browser test).
- **Import limits.**
  - Per request: 20 runs, 20 cases each, 100k characters.
  - Per day: 2 imports per IP and 100 overall. The counters live in
    `usage_daily` under `import:` keys, apart from the case budget.
  - A refused quota throws inside the transaction, so the per-IP count rolls
    back when the global one is full.
  - Invalid entries are skipped, not fatal.
- **Results are joined to cases through the stored run.** A second import
  that reuses an id with different cases can't write rows onto another
  dataset (tested; one of the mutations).
- **Share pages read the database directly** (server components, no API hop).
  - `connection()` makes them render per request, so a finished run never
    shows a cached "running" page.
  - They are `noindex`.
  - While a run is unfinished, a tiny client component calls
    `router.refresh()` every 3 s. It isn't rendered once the run is done, so
    the polling stops by itself.
- **The home page polls each launched run every 2 s** and stops polling each
  one when it finishes. Every run is fetched at least once, so a run that
  failed to queue shows its error.
- **Inline queue for local development** (part of the approved design). It
  refuses production: a serverless function can be frozen once its response
  is sent, which would strand a run halfway. Retries use `queueRetry`, so
  local behavior matches the real queue.
- **"Running" bubbles are the next batch, not every missing case.** The worker
  takes the 5 lowest missing positions, so those pulse and the rest show as
  waiting. It is an estimate (once part of a batch is done, the next cases
  shown are still waiting), noted in the code. `BATCH_SIZE` moved to
  `lib/eval.ts` so browser code can import it.
- **Diff: a is the baseline, b the candidate.** Picking two runs from history
  makes the older one the baseline. The page lists only cases that flipped
  (fixed or regressed), with input and expected shown once and the two
  answers side by side.

**Known gaps**
- Reloading the home page mid-run drops the live scoreboard. The run keeps
  going, and the history row and share page show its progress.
- A v1 history over the 100k-character import cap stays in localStorage, and
  the import is retried (and refused) on each visit. Unlikely with v1's caps.
- `docs/home.png` still shows the v1 page. Retake it after the Day 4 deploy.
- Still open from Day 2: re-enqueue for stuck runs, the forged-callback check,
  and the Anthropic Console limit (all Day 4).

**Next (Day 4)** (needs account clicks in Neon and Vercel):
- A new Neon project and Vercel Queues on the Vercel project.
- Env vars on Vercel: `DATABASE_URL`, `DAILY_SPEND_CAP_USD`,
  `EVALBOARD_ADMIN_TOKEN`. Then `npm run db:migrate` against Neon.
- A preview deploy, then a 250-case Banking77 run with the admin token, past
  300 s.
- Fault injection on the real queue: kill a batch, check it resumes with no
  duplicates.
- Admin re-enqueue for stuck runs, the forged-callback check, and a monthly
  limit in the Anthropic Console.
- Open a share link in a private window, and record the numbers.

## Day 4 (2026-11-03)

**Done**
- Neon (free plan, AWS us-east-1, next to the functions in iad1), created
  through the Vercel Marketplace, so `DATABASE_URL` (pooled) and
  `DATABASE_URL_UNPOOLED` were added to Preview and Production without
  anyone copying a password. Migrations 001-003 applied over the direct URL;
  a second run says "Already up to date".
- Preview env vars, scoped to the `evalboard-v2` branch:
  `ANTHROPIC_API_KEY` and `EVALBOARD_ADMIN_TOKEN` as secrets,
  `DAILY_SPEND_CAP_USD=5`. The token is kept locally in `.env.admin.local`
  (gitignored).
- Admin resume: `POST /api/runs/[id]/resume` and migration 003
  (`runs.resumed_at`). Messages carry an optional `chain` id, which goes
  into the idempotency key.
- Queue consumer: 60 s lease instead of the SDK's 300 s, and
  `maxDeliveries: 12` on the trigger as a backstop.
- `scripts/banking77.mts` builds the Banking77 run (seed 77, 250 of the
  3,080 test messages, 74 of 77 intents) without storing data in the repo.
- Tests: 69 unit and 66 Postgres (+10: reopenRun x4, restarted chain,
  resume route x5). Planted bugs, each caught: resume ignoring
  `resumed_at` (2 tests failed), chain id left out of the idempotency key,
  chain id not passed on to the next batch.

**Measured on the preview** (`evalboard-d4q2f48h3`, all numbers from the
database)

| Run | Score | Cost | Avg latency | Queue wait | Whole run | Batch cycle p50 / max |
|---|---|---|---|---|---|---|
| Smoke, Haiku, 5 cases (public, no token) | 5/5 | $0.003 | 0.64 s | 0.9 s | 1.6 s | 1 batch |
| Haiku 4.5, 250 cases | 194/250 (77.6%) | $0.157 | 0.48 s | 1.0 s | 35 s | 0.62 / 1.96 s |
| Sonnet 4.6, 250 cases | 205/250 (82.0%) | $0.469 | 0.80 s | 0.2 s | 53 s | 1.03 / 1.65 s |
| Opus 4.8, 250 cases | 203/250 (81.2%) | $1.068 | 0.85 s | 0.2 s | 62 s | 1.22 / 3.34 s |

- The three 250-case runs were one launch, in parallel: 750 cases in 62 s,
  50 queue deliveries per run, no retries, no errors, no fallback model.
- 144 of the 148 wrong answers were real intents, just the wrong one; only 4
  weren't intent names (Haiku 3, Opus 1, Sonnet 0). So exact match isn't
  failing answers on formatting.
- Haiku to Sonnet on the diff page: 17 fixed, 6 regressed (matches SQL).
- Spend recorded for the day: $1.85 of the $5 cap.

**Kill and resume on the real queue**
1. A copy of the preview (`vercel redeploy`) ran the same 250 cases on Haiku.
2. At 80 rows I deleted that deployment (`vercel remove`). Deliveries already
   in flight finished, writing up to 120 rows within 4 s; then nothing. The
   run sat at `running`, 120/250, the "lost chain" case.
3. Resume right away: 409 ("still making progress"); without the token: 401.
4. After 15.4 min idle: 202, then a second resume right after: 409. The new
   chain ran on the branch preview and finished the remaining 130 cases in
   19 s.

Results:
- 250 rows for 250 cases.
- The 120 rows written before the kill are unchanged (output, verdict,
  timestamp, attempts, cost compared against a snapshot).
- No row was written during the stall, and exactly 130 after the resume.
- Score 195/250, against 194/250 for the uninterrupted Haiku run of the same
  cases. The model isn't deterministic: the two runs agree on 241/250
  verdicts and 234/250 outputs. "Same score" is proven with a deterministic
  model in `worker.db.test.ts`. Here the row counts and the unchanged rows
  show that nothing was double counted or run twice.

**Other checks**
- Forged callback: a POST to `/api/queues/eval-batch` with valid-looking
  CloudEvent headers gets 404, even through `vercel curl`, which gets past
  the preview login. Vercel doesn't route outside traffic to a queue
  consumer at all, which matters because the SDK trusts the body of a
  binary-mode callback.
- Share page via `vercel curl`: `/runs/[id]` renders from the database with
  the right title and `noindex`; an unknown id is a 404.

**Decisions and why**
- **Kill by deleting the deployment, not a fault-injection flag.** Vercel
  pins a message to the deployment that sent it, and deleting a deployment
  stops its consumers. That is a real way to lose a worker, and it needs no
  test-only code in the worker. A crash in the middle of a batch is already
  covered by the Postgres test. The real-queue test covers the path the test
  can't: a chain that is gone for good, and an admin restart from a
  different deployment.
- **Resume rule: failed, or 15 min without activity.** The longest normal
  silence is a 5 min redelivery wait plus a 300 s delivery. Restarting a
  live chain wouldn't double count (insert-once), but it would pay for the
  remaining cases twice.
- **`resumed_at` counts as activity, and the check is one `UPDATE`.** Two
  resumes at once: the second waits on the row lock, re-checks the
  condition against the updated row, and matches nothing. Tested with 2
  concurrent calls.
- **A chain id in the idempotency key.** A restarted chain starts again at
  seq 0. With the old `runId:seq` key, the queue would drop its messages as
  repeats of the first chain's for 24 h, and the resume would quietly do
  nothing (one of the planted bugs).
- **60 s lease.** With the default 300 s, a crashed instance holds its batch
  for up to 5 minutes. The SDK renews every 12 s while a batch runs, and a
  batch takes 1-3 s.
- **Migrations over the direct URL, the app over the pooled one.** The
  migration runner holds `pg_advisory_lock` for a session, which a
  transaction-mode pooler doesn't keep.
- **Preview secrets are scoped to this branch**, so another branch's
  preview gets no API key.

**Not done, and why**
- **A run "well past 300 s".** The worker is faster than planned: a batch
  of 5 takes 0.6-1.2 s, so 250 cases take 35-62 s, and even the admin cap
  of 1,000 cases on Haiku would be a bit over 2 min. The honest way past 300 s
  is the full 3,080-message test split (about 7 min on Haiku, about $2,
  which also gives a score you can compare with published Banking77
  numbers). That needs the admin cap raised, and the run page reworked
  first: a 250-case page is 1.0 MB of HTML (57 KB gzipped), so 3,080 cases
  would be about 12 MB, re-sent every 3 s while the run is going. Decision
  for next session.
- **A share link in a private window.** Preview deployments are behind
  Vercel Authentication, so a private window gets the Vercel login, as it
  should. Checked on production after the merge (Day 6).
- **The Anthropic Console monthly limit** is set by hand in the console;
  the code can't do it.

**Known gaps**
- The models in `lib/eval.ts` (Haiku 4.5, Sonnet 4.6, Opus 4.8) still
  work, but they are a generation behind (the Claude 5 models are out).
  Updating the list and the price table is a small change, but it changes
  what the numbers above mean, so do it as its own step.
- `pg` warns that `sslmode=require` is treated as `verify-full`. That is the
  strict setting, so nothing is wrong, but the warning shows in the logs.
- `docs/home.png` still shows v1 (retake after the production deploy).

**Next (decided 2026-11-03):** first the run past 300 s: raise the admin
cap, make the run page work at 3,000+ cases, then run all 3,080 Banking77
test messages on Haiku (about 7 min, about $2) and record the numbers. Then
Day 5 (prompt A/B, CSV upload).

