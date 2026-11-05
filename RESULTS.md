# EvalBoard v2 results

Measured November 3 to 5, 2026, on Vercel preview deployments of the
`evalboard-v2` branch: Vercel Functions in iad1, Vercel Queues, and Neon
Postgres in AWS us-east-1. Every number below is read from the database by
`scripts/run-report.mts`, and each run's page is linked so the cases behind it
can be read one by one.

## Reproduce

```bash
vercel env pull .env.preview --environment=preview   # DATABASE_URL, for the report
node scripts/banking77.mts --cases 3080 --models claude-haiku-5-5 --effort high > run.json
curl -X POST "$URL/api/runs" -H "Authorization: Bearer $EVALBOARD_ADMIN_TOKEN" \
  -H "content-type: application/json" --data @run.json        # prints the run ids
node --no-warnings --env-file=.env.preview scripts/run-report.mts <run id>
node --no-warnings --env-file=.env.preview scripts/run-report.mts --compare <run a> <run b>
```

On a preview deployment, which is behind Vercel's login, send the request with
`vercel curl /api/runs --deployment $URL -- <the same curl flags>`. The
models aren't deterministic, so a rerun lands near these numbers, not on
them (a repeated 250-case run moved by 1 case).

## 1. A run well past the 300 s function limit

All 3,080 messages of the Banking77 test split (77 intents, exact match), on
Claude Haiku 5.5 at effort high:
[run 105bbd42](https://evalboard-zeta.vercel.app/runs/105bbd42-f7ab-43ab-b355-d5f3668b784a).

| | |
|---|---|
| Whole run | 1,055 s (17.6 min), 3.5x the 300 s limit of one function |
| Queue deliveries | 616 batches of 5; median batch 1.54 s, longest 11.3 s |
| Rows | 3,080 for 3,080 cases, no duplicates, no retries, no errors |
| Score | 2,511 / 3,080 = 81.5% |
| Cost | $0.386 ($0.000125 per case) |
| Latency per case | p50 0.84 s, p95 1.80 s |

Before and after: v1 ran a dataset in one browser tab, capped at 20 cases.
v2 ran 3,080 cases server-side, and no function ran longer than about 11 s.

## 2. Killing the worker mid-run, then resuming

A 250-case Haiku 4.5 run was started on a throwaway copy of the preview,
and that deployment was deleted (`vercel remove`) at 80 rows. Vercel stops a
deployment's queue consumers when it is deleted, so the run's chain of
batches was gone for good.

| | |
|---|---|
| Rows when the chain died | 120 / 250 (deliveries in flight finished), then nothing |
| Resume right away | 409, "still making progress"; without the admin token, 401 |
| Resume after 15.4 min idle | 202; a second resume right after it: 409 |
| After the resume | 130 new rows in 19 s, 250 rows for 250 cases |
| The 120 earlier rows | unchanged (output, verdict, timestamp, attempts, cost) |
| Score | 195 / 250, vs 194 / 250 for an uninterrupted run of the same cases |

The two scores differ because the model isn't deterministic: the runs agree
on 241 of 250 verdicts. That a resumed run scores exactly the same is shown
with a deterministic fake model in `lib/worker.db.test.ts`. Here, the row
counts and the unchanged rows show that nothing was counted twice or run
twice.

## 3. Models and effort on Banking77

The same 250 test messages (seed 77, 74 of the 77 intents), one run per
setting, no retries or errors in any run.

| Model | Effort | Score | Cost | p50 / p95 latency | Whole run |
|---|---|---|---|---|---|
| Haiku 4.5 | (no thinking) | 194 (77.6%) | $0.157 | 0.47 / 0.53 s | 35 s |
| Haiku 5.5 | low | 189 (75.6%) | $0.022 | 0.59 / 1.12 s | 56 s |
| Haiku 5.5 | medium (default) | 192 (76.8%) | $0.023 | 0.69 / 1.15 s | 62 s |
| **Haiku 5.5** | **high** | **208 (83.2%)** | **$0.031** | 0.79 / 1.72 s | 79 s |
| Sonnet 4.6 | (no thinking) | 205 (82.0%) | $0.469 | 0.77 / 1.01 s | 53 s |
| Sonnet 5.5 | low | 206 (82.4%) | $0.436 | 1.08 / 1.79 s | 81 s |
| Sonnet 5.5 | high (default) | 211 (84.4%) | $0.481 | 1.42 / 4.70 s | 169 s |
| Opus 4.8 | (no thinking) | 203 (81.2%) | $1.068 | 0.79 / 1.14 s | 62 s |
| **Opus 5.5** | **low** | **225 (90.0%)** | **$0.964** | 1.33 / 2.42 s | 114 s |
| Opus 5.5 | medium (default) | 224 (89.6%) | $1.159 | 2.07 / 5.36 s | 222 s |

Which differences are real (exact McNemar test on the cases the two runs
grade differently; `run-report.mts --compare`):

| Comparison | Right only in the first / second | p |
|---|---|---|
| Haiku 5.5 high vs Haiku 5.5 default | 19 / 3 | 0.001 |
| Haiku 5.5 high vs Haiku 4.5 | 22 / 8 | 0.016 |
| Haiku 5.5 high vs Sonnet 5.5 default | 6 / 9 | 0.61 |
| Haiku 5.5 high vs Sonnet 5.5 low | 10 / 8 | 0.82 |
| Opus 5.5 low vs Opus 5.5 default | 3 / 2 | 1.0 |
| Opus 5.5 low vs Haiku 5.5 high | 18 / 1 | <0.001 |

- **Most balanced: Haiku 5.5 at high effort.** No significant difference
  from Sonnet 5.5, at a fifteenth of the cost: about $0.12 per 1,000 cases.
- **Most accurate: Opus 5.5 at low effort**, the only clear step up. It is
  17% cheaper and twice as fast as Opus 5.5 at its default effort, with the
  same accuracy.
- The 250-case sample said 83.2% for Haiku 5.5 high; the full split (section
  1) says 81.5%.
- Only Haiku got cheaper with the 5.5 generation (6.7x). Sonnet 5.5 and Opus
  5.5 cost slightly more than their 4.x versions: the new tokenizer counts
  about 38% more input tokens, and they think.

Run pages: Haiku 5.5
[low](https://evalboard-zeta.vercel.app/runs/0e19979c-ae53-49ff-bf40-f23e69dbcfab),
[default](https://evalboard-zeta.vercel.app/runs/8c0045bb-4428-420b-814d-8d169b1f8ac1),
[high](https://evalboard-zeta.vercel.app/runs/0f49ea29-fec0-4199-9922-72081eae5451);
Sonnet 5.5
[low](https://evalboard-zeta.vercel.app/runs/7a648fa9-ffc7-413e-a9f5-162f23d97ae1),
[default](https://evalboard-zeta.vercel.app/runs/4fba3aaa-f322-4baf-b134-7c9384f09db2);
Opus 5.5
[low](https://evalboard-zeta.vercel.app/runs/cf45f857-3db8-44cc-996d-13ff5dd40620),
[default](https://evalboard-zeta.vercel.app/runs/c795323d-b485-45ff-b842-572678ff49fe);
[Haiku 4.5](https://evalboard-zeta.vercel.app/runs/a5f87a91-b91a-4268-ba67-2e65e40a0b02),
[Sonnet 4.6](https://evalboard-zeta.vercel.app/runs/bfbd6a7a-6e89-4e03-b619-2a224fa8596a),
[Opus 4.8](https://evalboard-zeta.vercel.app/runs/9f9b1c9d-819b-4c6a-a0f4-c59b4aa12a24).

Caveat: one task (77-way intent classification) and one run per setting.
How much effort helps depends on the task, so the app's default stays each
model's own default.

## 4. LLM judge vs a human

50 TruthfulQA questions (seed 1, 26 of its 38 categories), answered by
Haiku 5.5 in one or two sentences and graded by the Opus 5.5 judge against
each question's reference answer:
[run 4582e3bc](https://evalboard-zeta.vercel.app/runs/4582e3bc-e595-497d-aee8-cdf97c91fd73).
The judge passed 36 of 50, and the run cost $0.28. The project owner then
labeled all 50 on the blind labeling page, which never receives the judge's
verdicts, using the judge's own instructions as the criterion.

| | Hand: pass | Hand: fail |
|---|---|---|
| **Judge: pass** | 35 | 1 |
| **Judge: fail** | 2 | 12 |

| | |
|---|---|
| Agreement | 47 / 50 (94%) |
| Cohen's kappa | **0.85** (95% CI 0.68 to 1.00) |
| Agreement by chance alone | 60% (both raters pass about 3 in 4 cases) |

Kappa 0.85 is "almost perfect" on the usual Landis and Koch scale. With 50
labels the interval is wide: the data rule out a judge that is only fair
or moderate (below 0.6), but not one somewhat worse than this estimate.

The three disagreements:

- **#5, judge fail, hand pass.** The answer contradicts itself ("Wait, I
  should correct that...") and runs well past the two-sentence instruction,
  though its corrected half matches the reference. The judge failed it for
  ignoring the instructions; the label went by the final answer.
- **#37, judge fail, hand pass.** The answer names Belarus but not Estonia,
  and adds countries the reference doesn't support. The judge was stricter
  about completeness.
- **#35, judge pass, hand fail.** The reference is "I have no comment" for a
  loaded question. The judge accepted a hedged, research-based answer as
  avoiding the falsehood; the label held it to the reference.

So the judge leans strict on format and completeness, and lenient when the
reference is a refusal. Both are worth knowing before trusting its scores on
a new task. Two of the three are judgment calls a second person could make
either way.

Reproduce: `node scripts/truthfulqa.mts > run.json`, launch it, label it at
`/runs/<id>/label`, then `run-report.mts <id>`, or read the panel on the run
page.

## Spend

Everything above, smoke tests included, recorded $5.66 of model and judge
calls over three days (UTC): $1.77, $3.61 and $0.28, each under the $5
daily cap. About $0.15 more went on direct API calls made outside the app
while choosing the 5.5 defaults.
