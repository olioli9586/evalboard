"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MODELS,
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
    return customText
      .split("\n")
      .map((line) => {
        const sep = line.indexOf("|");
        if (sep === -1) return null;
        return {
          input: line.slice(0, sep).trim(),
          expected: line.slice(sep + 1).trim(),
        };
      })
      .filter((c): c is EvalCase => !!c && !!c.input && !!c.expected)
      .slice(0, MAX_CASES);
  }, [datasetIdx, customText]);

  function pickDataset(idx: number) {
    setDatasetIdx(idx);
    setGrid({});
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

    const fresh: Grid = {};
    for (const m of selectedModels) fresh[m] = cases.map(() => ({ status: "idle" }));
    setGrid(fresh);

    const jobs = selectedModels.flatMap((model) =>
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
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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
    for (const m of selectedModels) {
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
        dataset: datasetIdx >= 0 ? SAMPLES[datasetIdx].name : "custom",
        grader,
        system,
        caseKey: JSON.stringify(cases.map((c) => c.input)),
        caseCount: cases.length,
        models,
      }),
    );
  }

  function exportJson() {
    const payload = {
      dataset: datasetIdx >= 0 ? SAMPLES[datasetIdx].name : "custom",
      system,
      grader,
      cases,
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

  const hasResults = Object.keys(grid).length > 0;
  const detailCell = detail ? grid[detail.model]?.[detail.idx] : null;

  return (
    <main className="min-h-screen">
      {/* Header band */}
      <div className="graph-paper border-b border-rule bg-card">
        <div className="mx-auto max-w-4xl px-6 py-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-cal">
            ⊞ LLM evaluation bench
          </p>
          <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
            Measure the model.
            <span className="text-cal"> Not the vibes.</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
            Run a dataset against multiple Claude models, grade every output — exact
            match or LLM-as-judge — and compare accuracy, latency, and cost side by side.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-6 pb-24">
        {/* Setup */}
        <section className="mt-10 grid gap-6 sm:grid-cols-[1fr_240px]">
          <div className="space-y-5">
            <div>
              <Label>Dataset</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {SAMPLES.map((s, i) => (
                  <Chip key={s.name} active={datasetIdx === i} onClick={() => pickDataset(i)}>
                    {s.name}
                  </Chip>
                ))}
                <Chip active={datasetIdx === -1} onClick={() => pickDataset(-1)}>
                  custom
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
                  placeholder={"one case per line:  input | expected\nWhat is 2+2? | 4"}
                  className="mt-2 w-full resize-y rounded-md border border-rule bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-cal"
                />
              )}
            </div>

            <div>
              <Label>System prompt (the thing under test)</Label>
              <textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                rows={3}
                className="mt-2 w-full resize-y rounded-md border border-rule bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-cal"
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
                      className="h-3.5 w-3.5 accent-[#2247d6]"
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
                  exact match
                </Chip>
                <Chip active={grader === "judge"} onClick={() => setGrader("judge")}>
                  LLM judge
                </Chip>
              </div>
              <p className="mt-2 text-[12px] leading-snug text-muted">
                {grader === "exact"
                  ? "Normalized string equality. Free, deterministic."
                  : "Opus 4.8 rules on semantic equivalence with a structured verdict."}
              </p>
            </div>

            <button
              onClick={runAll}
              disabled={running || cases.length === 0 || selectedModels.length === 0}
              className="w-full rounded-md bg-cal px-4 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-white transition hover:bg-[#1a38ad] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cal disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running
                ? "Running…"
                : `Run ${cases.length * selectedModels.length || ""} calls`}
            </button>
          </div>
        </section>

        {runError && (
          <p role="alert" className="mt-6 rounded-md border border-fail/40 bg-fail/5 px-4 py-3 text-sm text-fail">
            {runError}
          </p>
        )}

        {/* Scoreboard */}
        {hasResults && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-lg font-bold">Readout</h2>
              <button
                onClick={exportJson}
                className="font-mono text-[12px] text-muted underline decoration-rule underline-offset-4 hover:text-cal"
              >
                export run.json
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {selectedModels.map((model) => {
                const cells = grid[model] ?? [];
                const done = cells.filter((c) => c.status === "done") as Extract<Cell, { status: "done" }>[];
                const passed = done.filter((c) => c.r.pass).length;
                const avgMs = done.length
                  ? Math.round(done.reduce((s, c) => s + c.r.latency_ms, 0) / done.length)
                  : 0;
                const totalCost = done.reduce((s, c) => s + c.r.cost_usd, 0);
                const rate = done.length ? Math.round((passed / done.length) * 100) : null;
                return (
                  <div key={model} className="rounded-lg border border-rule bg-card p-5">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <span className="w-40 font-mono text-[13px] font-medium">
                        {model.replace("claude-", "")}
                      </span>
                      <span className="font-display text-3xl font-bold tabular-nums">
                        {rate === null ? "—" : `${rate}%`}
                      </span>
                      {/* Test strip — the signature: one square per case */}
                      <div className="flex gap-1" role="img" aria-label={`${passed} of ${done.length} passed`}>
                        {cells.map((cell, idx) => (
                          <button
                            key={idx}
                            onClick={() => cell.status === "done" && setDetail({ model, idx })}
                            title={`case ${idx + 1}`}
                            className={`h-5 w-5 rounded-[3px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cal ${
                              cell.status === "done"
                                ? cell.r.pass
                                  ? "cell-pop cursor-pointer bg-pass hover:opacity-80"
                                  : "cell-pop cursor-pointer bg-fail hover:opacity-80"
                                : cell.status === "running"
                                  ? "animate-pulse bg-cal/40"
                                  : cell.status === "error"
                                    ? "bg-fail/25"
                                    : "bg-rule"
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
            <p className="mt-3 font-mono text-[11px] text-muted">
              click a square to inspect the case
            </p>
          </section>
        )}

        {/* Case detail */}
        {detail && detailCell?.status === "done" && (
          <section className="mt-8 rounded-lg border border-cal/30 bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-sm font-bold uppercase tracking-wider">
                Case {detail.idx + 1} · {detail.model.replace("claude-", "")} ·{" "}
                <span className={detailCell.r.pass ? "text-pass" : "text-fail"}>
                  {detailCell.r.pass ? "pass" : "fail"}
                </span>
              </h3>
              <button
                onClick={() => setDetail(null)}
                className="font-mono text-[12px] text-muted hover:text-ink"
              >
                close ✕
              </button>
            </div>
            <dl className="mt-4 space-y-3 text-[14px]">
              <DetailRow label="Input" value={cases[detail.idx]?.input ?? ""} />
              <DetailRow label="Expected" value={cases[detail.idx]?.expected ?? ""} />
              <DetailRow label="Output" value={detailCell.r.output} mono />
              {detailCell.r.reasoning && (
                <DetailRow label="Judge reasoning" value={detailCell.r.reasoning} />
              )}
              <DetailRow
                label="Telemetry"
                value={`${detailCell.r.latency_ms} ms · ${detailCell.r.input_tokens} in / ${detailCell.r.output_tokens} out tokens · $${detailCell.r.cost_usd.toFixed(5)} · served by ${detailCell.r.model_used}`}
                mono
              />
            </dl>
          </section>
        )}

        {/* Run history + diff */}
        {runs.length > 0 && (
          <section className="mt-14">
            <h2 className="font-display text-lg font-bold">Run history</h2>
            <p className="mt-1 text-[13px] text-muted">
              Select two runs of the same dataset to diff them — the regression view.
            </p>
            <ul className="mt-4 space-y-2">
              {runs.map((run) => {
                const picked = diffPick.includes(run.id);
                return (
                  <li
                    key={run.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2.5 font-mono text-[12px] ${
                      picked ? "border-cal bg-cal/5" : "border-rule bg-card"
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
                      className="h-3.5 w-3.5 accent-[#2247d6]"
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
                      className="text-muted hover:text-fail"
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

        <footer className="mt-20 flex items-center justify-between border-t border-rule pt-5 font-mono text-[11px] text-muted">
          <span>Next.js · Claude API · structured-output judge</span>
          <a
            className="underline decoration-rule underline-offset-4 hover:text-cal"
            href="https://github.com/olioli9586/evalboard"
          >
            source ↗
          </a>
        </footer>
      </div>
    </main>
  );
}

const TRANSITION_STYLE: Record<Transition, { cls: string; label: string }> = {
  "pass-pass": { cls: "bg-pass/80", label: "pass → pass" },
  "fail-fail": { cls: "bg-rule", label: "fail → fail" },
  fixed: { cls: "bg-cal", label: "fixed" },
  regressed: { cls: "bg-fail", label: "regressed" },
  ungraded: { cls: "bg-rule/40", label: "ungraded" },
};

function DiffPanel({ runs, pick }: { runs: SavedRun[]; pick: string[] }) {
  const picked = runs.filter((r) => pick.includes(r.id));
  if (picked.length !== 2) return null;
  // Baseline = the older run.
  const [base, next] = [...picked].sort((a, b) => a.at.localeCompare(b.at));

  if (base.caseKey !== next.caseKey) {
    return (
      <p className="mt-4 rounded-md border border-rule bg-card px-4 py-3 text-[13px] text-muted">
        These runs used different cases, so a case-by-case diff isn&apos;t meaningful.
        Pick two runs of the same dataset.
      </p>
    );
  }

  const sharedModels = Object.keys(base.models).filter((m) => m in next.models);
  const promptChanged = base.system !== next.system;

  return (
    <div className="mt-4 rounded-lg border border-cal/30 bg-card p-5">
      <h3 className="font-display text-sm font-bold uppercase tracking-wider">
        Diff · baseline {new Date(base.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}{" "}
        → {new Date(next.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
      </h3>
      {promptChanged && (
        <p className="mt-2 font-mono text-[12px] text-cal">system prompt changed between runs</p>
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
                  {fixed > 0 && <span className="text-cal">{fixed} fixed</span>}
                  {fixed > 0 && regressed > 0 && " · "}
                  {regressed > 0 && <span className="text-fail">{regressed} regressed</span>}
                  {fixed === 0 && regressed === 0 && "no transitions"}
                </span>
              </div>
              <div className="mt-2 flex gap-1">
                {trans.map((t, i) => (
                  <span
                    key={i}
                    title={`case ${i + 1}: ${TRANSITION_STYLE[t].label}`}
                    className={`h-5 w-5 rounded-[3px] ${TRANSITION_STYLE[t].cls}`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-3 font-mono text-[11px] text-muted">
        {(Object.keys(TRANSITION_STYLE) as Transition[]).map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-[2px] ${TRANSITION_STYLE[t].cls}`} />
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
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">{children}</span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 font-mono text-[12px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cal ${
        active
          ? "border-cal bg-cal/10 text-cal"
          : "border-rule text-muted hover:border-cal/50 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
