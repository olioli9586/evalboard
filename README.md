# EvalBoard — LLM Evaluation Bench

Run a dataset against multiple Claude models, grade every output — exact match or
LLM-as-judge — and compare **accuracy, latency, and cost** side by side. Eval
literacy is the difference between "I built with LLMs" and "I watched tutorials";
this is the tool I use to prove which model/prompt combination actually works.

**Live demo:** _coming soon_

## How it works

```
Browser ── one POST per (model × case) ──▶ /api/run-case
             (client-side worker pool,          │
              concurrency 3)                    ├─ 1. target model completes the case
                                                ├─ 2. grader scores it:
                                                │    · exact  — normalized string equality
                                                │    · judge  — Opus 4.8 verdict, strict JSON schema
                                                └─ 3. returns {output, pass, reasoning,
                                                     latency, tokens, cost}
```

- **Datasets**: two built-in samples (classification with exact match; extraction
  with LLM judge) or paste your own as `input | expected` lines.
- **The readout**: per-model scorecards — pass rate, a test strip (one square per
  case, click to inspect), average latency, total cost.
- **Case detail**: input, expected, output, judge reasoning, and telemetry.
- **Export**: full run as JSON.

## Design decisions

- **LLM-as-judge with a structured verdict.** The judge returns
  `{pass, reasoning}` constrained by a strict JSON schema (`output_config.format`),
  so grades always parse. Reasoning is stored, not discarded — you can audit why
  a case failed.
- **Exact match is normalized** (case, trailing punctuation) — classification
  evals shouldn't fail on "Billing." vs "billing".
- **Client-side worker pool** (concurrency 3) instead of one long server job:
  every case is an independent short request, so results stream into the UI as
  they land, failures are isolated per-cell, and nothing fights serverless
  execution limits.
- **Cost is a first-class metric.** Every result carries token counts and a
  dollar figure computed from a price table; the scorecard totals them. Model
  choice is an economics question, not just an accuracy question.
- **Model fallback**: if a requested model returns 404 (retired), the case
  transparently reruns on `claude-opus-4-8` and the result records which model
  actually served it.
- **Demo guardrails**: per-IP daily case budget, case/input length caps.

## Run locally

```bash
npm install
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
npm run dev
```

## Tech

Next.js 16 (App Router) · TypeScript · Tailwind CSS · Anthropic SDK · Vercel

## Roadmap

- [ ] Persist runs to Postgres and diff two runs (regression view)
- [ ] Prompt variants: A/B two system prompts on the same dataset
- [ ] CSV dataset upload
- [ ] Statistical significance hints for small datasets
