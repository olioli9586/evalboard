"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MODELS,
  parseCustomCases,
  SAMPLES,
  type CaseResult,
  type EvalCase,
  type GraderKind,
} from "@/lib/eval";
import {
  deleteRun,
  loadRuns,
  saveRun,
  transition,
  type SavedRun,
  type Transition,
} from "@/lib/history";

type Cell =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; r: CaseResult }
  | { status: "error"; error: string };

type Grid = Record<string, Cell[]>; // model -> per-case cell

// What the current results were produced from. The setup form stays editable
// after a run, so results, case detail, and export read from this snapshot
// rather than from the live form state.
interface RunSnapshot {
  dataset: string;
  system: string;
  grader: GraderKind;
  cases: EvalCase[];
  models: string[];
}

const MAX_CASES = 20;
const CONCURRENCY = 3;

export default function Home() {
  const [datasetIdx, setDatasetIdx] = useState(0); // index into SAMPLES, or -1 = custom
  const [customText, setCustomText] = useState("");
  const [system, setSystem] = useState(SAMPLES[0].system);
  const [grader, setGrader] = useState<GraderKind>(SAMPLES[0].grader);
  const [selectedModels, setSelectedModels] = useState<string[]>([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
  ]);
  const [grid, setGrid] = useState<Grid>({});
  const [lastRun, setLastRun] = useState<RunSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [detail, setDetail] = useState<{ model: string; idx: number } | null>(null);
  const [runs, setRuns] = useState<SavedRun[]>([]);
  const [diffPick, setDiffPick] = useState<string[]>([]); // up to 2 run ids

  useEffect(() => {
    setRuns(loadRuns());
  }, []);

  const cases: EvalCase[] = useMemo(() => {
    if (datasetIdx >= 0) return SAMPLES[datasetIdx].cases;
    return parseCustomCases(customText, MAX_CASES);
  }, [datasetIdx, customText]);

  function pickDataset(idx: number) {
    // Switching mid-run would wipe the grid while workers are still filling it.
    if (running) return;
    setDatasetIdx(idx);
    setGrid({});
    setLastRun(null);
    setDetail(null);
    if (idx >= 0) {
      setSystem(SAMPLES[idx].system);
      setGrader(SAMPLES[idx].grader);
    }
  }

  async function runAll() {
    if (running || cases.length === 0 || selectedModels.length === 0) return;
    setRunning(true);
    setRunError("");
    setDetail(null);

    const snapshot: RunSnapshot = {
      dataset: datasetIdx >= 0 ? SAMPLES[datasetIdx].name : "custom",
      system,
      grader,
      cases,
      models: [...selectedModels],
    };
    const fresh: Grid = {};
    for (const m of snapshot.models) fresh[m] = cases.map(() => ({ status: "idle" }));
    setGrid(fresh);
    setLastRun(snapshot);

    const jobs = snapshot.models.flatMap((model) =>
      cases.map((c, idx) => ({ model, idx, c })),
    );

    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        setGrid((g) => setCell(g, job.model, job.idx, { status: "running" }));
        try {
          const res = await fetch("/api/run-case", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: job.model,
              system,
              input: job.c.input,
              expected: job.c.expected,
              grader,
            }),
          });
          // A platform error page (e.g. a function timeout) isn't JSON.
          const data = await res.json().catch(() => null);
          if (!res.ok || !data) throw new Error(data?.error ?? `HTTP ${res.status}`);
          fresh[job.model][job.idx] = { status: "done", r: data };
          setGrid((g) => setCell(g, job.model, job.idx, { status: "done", r: data }));
        } catch (err) {
          fresh[job.model][job.idx] = { status: "error", error: (err as Error).message };
          setGrid((g) =>
            setCell(g, job.model, job.idx, { status: "error", error: (err as Error).message }),
          );
          if ((err as Error).message.toLowerCase().includes("budget")) {
            cursor = jobs.length; // stop everything on rate limit
            setRunError("Daily demo budget reached — remaining cases were skipped.");
          }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setRunning(false);

    // Record the run for history/diffing.
    const models: SavedRun["models"] = {};
    for (const m of snapshot.models) {
      const cells = fresh[m];
      const done = cells.filter((c) => c.status === "done") as Extract<Cell, { status: "done" }>[];
      models[m] = {
        passes: cells.map((c) => (c.status === "done" ? c.r.pass : null)),
        passRate: done.length
          ? Math.round((done.filter((c) => c.r.pass).length / done.length) * 100)
          : 0,
        avgMs: done.length
          ? Math.round(done.reduce((s, c) => s + c.r.latency_ms, 0) / done.length)
          : 0,
        cost: done.reduce((s, c) => s + c.r.cost_usd, 0),
      };
    }
    setRuns(
      saveRun({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        dataset: snapshot.dataset,
        grader,
        system,
        caseKey: JSON.stringify(cases.map((c) => c.input)),
        caseCount: cases.length,
        models,
      }),
    );
  }

  function exportJson() {
    if (!lastRun) return;
    const payload = {
      dataset: lastRun.dataset,
      system: lastRun.system,
      grader: lastRun.grader,
      cases: lastRun.cases,
      results: grid,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "evalboard-run.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasResults = lastRun !== null;
  const detailCell = detail ? grid[detail.model]?.[detail.idx] : null;

  return (
    <main className="min-h-screen">
      {/* App header */}
      <header className="bg-board">
        <div className="mx-auto flex max-w-4xl flex-wrap items-end justify-between gap-x-8 gap-y-4 px-6 py-8">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
                <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
                <span className="h-2.5 w-2.5 rounded-full bg-fail" />
                <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
                <span className="h-2.5 w-2.5 rounded-full border border-chalk-dim" />
              </span>
              <h1 className="font-display text-3xl font-semibold text-chalk">Evalboard</h1>
            </div>
            <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-chalk-dim">
              Run a dataset against Claude models, grade every answer — exact match or
              LLM judge — and compare accuracy, latency, and cost.
            </p>
          </div>
          <a
            href="https://github.com/olioli9586/evalboard"
            className="text-[13px] font-medium text-chalk-dim underline-offset-4 transition hover:text-chalk hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chalk"
          >
            View source
          </a>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 pb-24">
        {/* Setup */}
        <section className="mt-8 rounded-xl border border-line bg-card p-6">
          <h2 className="font-display text-xl font-semibold">Set up a run</h2>
          <div className="mt-5 grid gap-6 sm:grid-cols-[1fr_250px]">
            <div className="space-y-5">
              <div>
                <Label>Dataset</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SAMPLES.map((s, i) => (
                    <Chip
                      key={s.name}
                      active={datasetIdx === i}
                      disabled={running}
                      onClick={() => pickDataset(i)}
                    >
                      {s.name}
                    </Chip>
                  ))}
                  <Chip active={datasetIdx === -1} disabled={running} onClick={() => pickDataset(-1)}>
                    Custom
                  </Chip>
                </div>
                {datasetIdx >= 0 ? (
                  <p className="mt-2 text-[13px] text-muted">
                    {SAMPLES[datasetIdx].description} · {cases.length} cases
                  </p>
                ) : (
                  <textarea
                    value={customText}
                    onChange={(e) => setCustomText(e.target.value)}
                    rows={5}
                    placeholder={"One case per line: input | expected\nWhat is 2+2? | 4"}
                    className="mt-2 w-full resize-y rounded-md border border-line bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-board"
                  />
                )}
              </div>

              <div>
                <Label>System prompt</Label>
                <p className="mt-1 text-[12px] text-muted">
                  This is the prompt you&apos;re testing — edit it between runs to measure the
                  difference.
                </p>
                <textarea
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-y rounded-md border border-line bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-board"
                />
              </div>
            </div>

            <div className="space-y-5">
              <div>
                <Label>Models</Label>
                <div className="mt-2 space-y-1.5">
                  {MODELS.map((m) => (
                    <label key={m} className="flex cursor-pointer items-center gap-2 font-mono text-[13px]">
                      <input
                        type="checkbox"
                        checked={selectedModels.includes(m)}
                        onChange={(e) =>
                          setSelectedModels((prev) =>
                            e.target.checked ? [...prev, m] : prev.filter((x) => x !== m),
                          )
                        }
                        className="h-3.5 w-3.5 accent-[#14332c]"
                      />
                      {m.replace("claude-", "")}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <Label>Grader</Label>
                <div className="mt-2 flex gap-2">
                  <Chip active={grader === "exact"} onClick={() => setGrader("exact")}>
                    Exact match
                  </Chip>
                  <Chip active={grader === "judge"} onClick={() => setGrader("judge")}>
                    LLM judge
                  </Chip>
                </div>
                <p className="mt-2 text-[12px] leading-snug text-muted">
                  {grader === "exact"
                    ? "Case-insensitive string comparison. Free and deterministic."
                    : "Opus 4.8 compares each answer to the expected one and explains its verdict."}
                </p>
              </div>

              <button
                onClick={runAll}
                disabled={running || cases.length === 0 || selectedModels.length === 0}
                className="w-full rounded-lg bg-board px-4 py-2.5 text-sm font-semibold text-chalk transition hover:bg-[#1d4a40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board disabled:cursor-not-allowed disabled:opacity-40"
              >
                {running
                  ? "Running…"
                  : `Run ${cases.length * selectedModels.length || ""} tests`}
              </button>
            </div>
          </div>
        </section>

        {runError && (
          <p role="alert" className="mt-6 rounded-md border border-fail/40 bg-fail/5 px-4 py-3 text-sm text-fail">
            {runError}
          </p>
        )}

        {/* Results — empty state invites the first run */}
        {!hasResults && (
          <section className="mt-12">
            <h2 className="font-display text-xl font-semibold">Results</h2>
            <div className="mt-4 rounded-xl border border-line bg-card p-6">
              <div className="flex gap-1" aria-hidden="true">
                {Array.from({ length: 10 }).map((_, i) => (
                  <span key={i} className="h-5 w-5 rounded-full border border-dashed border-line" />
                ))}
              </div>
              <p className="mt-3 text-[14px] text-muted">
                No results yet. Pick a dataset, choose your models, and run the tests —
                each bubble fills in as a case is graded.
              </p>
            </div>
          </section>
        )}

        {/* Scoreboard */}
        {hasResults && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-xl font-semibold">Results</h2>
              <button
                onClick={exportJson}
                className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] font-medium transition hover:border-board focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
              >
                Download JSON
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {lastRun.models.map((model) => {
                const cells = grid[model] ?? [];
                const done = cells.filter((c) => c.status === "done") as Extract<Cell, { status: "done" }>[];
                const passed = done.filter((c) => c.r.pass).length;
                const avgMs = done.length
                  ? Math.round(done.reduce((s, c) => s + c.r.latency_ms, 0) / done.length)
                  : 0;
                const totalCost = done.reduce((s, c) => s + c.r.cost_usd, 0);
                const rate = done.length ? Math.round((passed / done.length) * 100) : null;
                return (
                  <div key={model} className="rounded-xl border border-line bg-card p-5">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <span className="w-40 font-mono text-[13px] font-medium">
                        {model.replace("claude-", "")}
                      </span>
                      <span className="font-display text-3xl font-bold tabular-nums">
                        {rate === null ? "—" : `${rate}%`}
                      </span>
                      {/* Answer bubbles — the signature: one per case, filled as graded */}
                      <div className="flex gap-1" role="img" aria-label={`${passed} of ${done.length} passed`}>
                        {cells.map((cell, idx) => (
                          <button
                            key={idx}
                            onClick={() =>
                              (cell.status === "done" || cell.status === "error") &&
                              setDetail({ model, idx })
                            }
                            title={`case ${idx + 1}`}
                            className={`h-5 w-5 rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-board ${
                              cell.status === "done"
                                ? cell.r.pass
                                  ? "cell-pop cursor-pointer bg-pass hover:opacity-80"
                                  : "cell-pop cursor-pointer bg-fail hover:opacity-80"
                                : cell.status === "running"
                                  ? "animate-pulse bg-board/30"
                                  : cell.status === "error"
                                    ? "cursor-pointer border-2 border-fail bg-fail/10 hover:bg-fail/25"
                                    : "border border-line"
                            }`}
                          />
                        ))}
                      </div>
                      <span className="ml-auto font-mono text-[12px] text-muted">
                        {avgMs ? `${avgMs} ms avg` : ""}
                        {totalCost ? ` · $${totalCost.toFixed(4)}` : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[12px] text-muted">
              Select a bubble to see the full input, answer, and verdict.
            </p>
          </section>
        )}

        {/* Case detail */}
        {lastRun && detail && detailCell && (detailCell.status === "done" || detailCell.status === "error") && (
          <section className="mt-8 rounded-xl border border-board/30 bg-card p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-display text-base font-semibold">
                Case {detail.idx + 1} · {detail.model.replace("claude-", "")} —{" "}
                {detailCell.status === "done" ? (
                  <span className={detailCell.r.pass ? "text-pass" : "text-fail"}>
                    {detailCell.r.pass ? "Pass" : "Fail"}
                  </span>
                ) : (
                  <span className="text-fail">Error</span>
                )}
              </h3>
              <button
                onClick={() => setDetail(null)}
                className="text-[13px] font-medium text-muted transition hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
              >
                Close
              </button>
            </div>
            <dl className="mt-4 space-y-3 text-[14px]">
              <DetailRow label="Input" value={lastRun.cases[detail.idx]?.input ?? ""} />
              <DetailRow label="Expected" value={lastRun.cases[detail.idx]?.expected ?? ""} />
              {detailCell.status === "done" ? (
                <>
                  <DetailRow label="Output" value={detailCell.r.output} mono />
                  {detailCell.r.reasoning && (
                    <DetailRow label="Judge's reasoning" value={detailCell.r.reasoning} />
                  )}
                  <DetailRow
                    label="Timing and cost"
                    value={`${detailCell.r.latency_ms} ms · ${detailCell.r.input_tokens} in / ${detailCell.r.output_tokens} out tokens · $${detailCell.r.cost_usd.toFixed(5)} · served by ${detailCell.r.model_used}`}
                    mono
                  />
                </>
              ) : (
                <DetailRow label="What went wrong" value={detailCell.error} mono />
              )}
            </dl>
          </section>
        )}

        {/* Run history + diff */}
        {runs.length > 0 && (
          <section className="mt-14">
            <h2 className="font-display text-xl font-semibold">Run history</h2>
            <p className="mt-1 text-[13px] text-muted">
              Pick two runs of the same dataset to compare them case by case.
            </p>
            <ul className="mt-4 space-y-2">
              {runs.map((run) => {
                const picked = diffPick.includes(run.id);
                return (
                  <li
                    key={run.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2.5 font-mono text-[12px] ${
                      picked ? "border-board bg-board/5" : "border-line bg-card"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() =>
                        setDiffPick((prev) =>
                          picked ? prev.filter((id) => id !== run.id) : [...prev, run.id].slice(-2),
                        )
                      }
                      className="h-3.5 w-3.5 accent-[#14332c]"
                      aria-label="select run for diff"
                    />
                    <span className="text-ink">{run.dataset}</span>
                    <span className="text-muted">
                      {new Date(run.at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="text-muted">{run.grader}</span>
                    <span className="ml-auto text-muted">
                      {Object.entries(run.models)
                        .map(([m, r]) => `${m.replace("claude-", "")} ${r.passRate}%`)
                        .join(" · ")}
                    </span>
                    <button
                      onClick={() => {
                        setRuns(deleteRun(run.id));
                        setDiffPick((prev) => prev.filter((id) => id !== run.id));
                      }}
                      className="text-muted transition hover:text-fail focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
                      aria-label="delete run"
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>

            {diffPick.length === 2 && <DiffPanel runs={runs} pick={diffPick} />}
          </section>
        )}

        <footer className="mt-20 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-5 text-[12px] text-muted">
          <span>Run history is saved in this browser.</span>
          <a
            className="font-medium underline-offset-4 transition hover:text-board hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
            href="https://github.com/olioli9586/evalboard"
          >
            View source on GitHub
          </a>
        </footer>
      </div>
    </main>
  );
}

const TRANSITION_STYLE: Record<Transition, { cls: string; label: string }> = {
  "pass-pass": { cls: "bg-pass/55", label: "pass → pass" },
  "fail-fail": { cls: "bg-line", label: "fail → fail" },
  fixed: { cls: "bg-board", label: "fixed" },
  regressed: { cls: "bg-fail", label: "regressed" },
  ungraded: { cls: "border border-dashed border-line", label: "ungraded" },
};

function DiffPanel({ runs, pick }: { runs: SavedRun[]; pick: string[] }) {
  const picked = runs.filter((r) => pick.includes(r.id));
  if (picked.length !== 2) return null;
  // Baseline = the older run.
  const [base, next] = [...picked].sort((a, b) => a.at.localeCompare(b.at));

  if (base.caseKey !== next.caseKey) {
    return (
      <p className="mt-4 rounded-md border border-line bg-card px-4 py-3 text-[13px] text-muted">
        These runs used different cases, so a case-by-case comparison isn&apos;t meaningful.
        Pick two runs of the same dataset.
      </p>
    );
  }

  const sharedModels = Object.keys(base.models).filter((m) => m in next.models);
  const promptChanged = base.system !== next.system;

  return (
    <div className="mt-4 rounded-xl border border-board/30 bg-card p-5">
      <h3 className="font-display text-base font-semibold">
        Comparing runs · {new Date(base.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}{" "}
        → {new Date(next.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
      </h3>
      {promptChanged && (
        <p className="mt-2 text-[13px] font-medium text-board">
          The system prompt changed between these runs.
        </p>
      )}

      <div className="mt-4 space-y-4">
        {sharedModels.length === 0 && (
          <p className="text-[13px] text-muted">No model appears in both runs.</p>
        )}
        {sharedModels.map((model) => {
          const a = base.models[model];
          const b = next.models[model];
          const trans = a.passes.map((p, i) => transition(p, b.passes[i]));
          const fixed = trans.filter((t) => t === "fixed").length;
          const regressed = trans.filter((t) => t === "regressed").length;
          const delta = b.passRate - a.passRate;
          return (
            <div key={model}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="w-40 font-mono text-[13px] font-medium">
                  {model.replace("claude-", "")}
                </span>
                <span className="font-display text-xl font-bold tabular-nums">
                  {a.passRate}% → {b.passRate}%
                </span>
                <span
                  className={`font-mono text-[12px] ${
                    delta > 0 ? "text-pass" : delta < 0 ? "text-fail" : "text-muted"
                  }`}
                >
                  {delta > 0 ? `+${delta}` : delta} pts
                </span>
                <span className="ml-auto font-mono text-[12px] text-muted">
                  {fixed > 0 && <span className="text-board">{fixed} fixed</span>}
                  {fixed > 0 && regressed > 0 && " · "}
                  {regressed > 0 && <span className="text-fail">{regressed} regressed</span>}
                  {fixed === 0 && regressed === 0 && "no changes"}
                </span>
              </div>
              <div className="mt-2 flex gap-1">
                {trans.map((t, i) => (
                  <span
                    key={i}
                    title={`case ${i + 1}: ${TRANSITION_STYLE[t].label}`}
                    className={`h-5 w-5 rounded-full ${TRANSITION_STYLE[t].cls}`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-muted">
        {(Object.keys(TRANSITION_STYLE) as Transition[]).map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-full ${TRANSITION_STYLE[t].cls}`} />
            {TRANSITION_STYLE[t].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function setCell(g: Grid, model: string, idx: number, cell: Cell): Grid {
  const next = { ...g, [model]: [...(g[model] ?? [])] };
  next[model][idx] = cell;
  return next;
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] font-semibold text-ink">{children}</span>;
}

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-1.5 text-[13px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board disabled:cursor-not-allowed disabled:opacity-60 ${
        active
          ? "border-board bg-board text-chalk"
          : "border-line bg-card text-ink hover:border-board/50"
      }`}
    >
      {children}
    </button>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
