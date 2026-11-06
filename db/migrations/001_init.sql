-- EvalBoard v2 schema: datasets of cases, runs of one model + prompt over a
-- dataset, and one result row per (run, case).

create table datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source text not null check (source in ('sample', 'custom', 'csv', 'import')),
  -- sha256 of the case list: launching the same cases again reuses the rows
  -- instead of storing a copy per run.
  content_hash text not null unique,
  case_count integer not null check (case_count > 0),
  created_at timestamptz not null default now()
);

create table cases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets (id) on delete cascade,
  position integer not null,
  input text not null,
  expected text not null,
  unique (dataset_id, position)
);

-- One run = one model under one system prompt over one dataset. Runs launched
-- together (several models, or prompt A vs B) share a group_id.
create table runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets (id),
  group_id uuid not null,
  model text not null,
  system_prompt text not null default '',
  prompt_label text,
  grader text not null check (grader in ('exact', 'judge')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  total_cases integer not null check (total_cases > 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index runs_created_at_idx on runs (created_at desc);
create index runs_group_id_idx on runs (group_id);

-- The primary key is what makes worker retries safe: a redelivered batch can
-- only ever write one row per case. It also serves lookups by run_id, so no
-- separate index on run_id. Scores are counted from these rows, never kept as
-- running totals that a retry could bump twice.
create table results (
  run_id uuid not null references runs (id) on delete cascade,
  case_id uuid not null references cases (id),
  output text not null default '',
  pass boolean, -- null when the case errored and was not graded
  error text,
  latency_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  judge_reasoning text not null default '',
  model_used text,
  attempts integer not null default 1,
  created_at timestamptz not null default now(),
  primary key (run_id, case_id)
);

-- Per-IP daily case budget for the public demo. Shared across serverless
-- instances, unlike the old in-memory counter.
create table usage_daily (
  ip text not null,
  day date not null,
  cases integer not null default 0 check (cases >= 0),
  primary key (ip, day)
);
