"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CaseDetail,
  CELL_CLASS,
  CELL_LABEL,
  cellState,
  formatWhen,
  isFinished,
  shortModel,
  SiteHeader,
  STATUS_LABEL,
  workingOn,
} from "@/components/ui";
import { passRate } from "@/lib/diff";
import { MODELS, parseCustomCases, SAMPLES, type EvalCase, type GraderKind } from "@/lib/eval";
import {
  addToHistory,
  clearLegacyRuns,
  forgetRuns,
  loadHistory,
  loadLegacyRuns,
  removeFromHistory,
} from "@/lib/history";
import type { ResultRow, Run, RunListItem, RunSummary } from "@/lib/store";

// A run as it arrives over JSON: dates are strings.
type RunJson = Omit<Run, "createdAt" | "startedAt" | "finishedAt"> & { createdAt: string };
type HistoryRun = RunJson & Pick<RunListItem, "datasetName" | "summary">;

interface LiveRun {
  run: RunJson;
  summary: RunSummary;
  results: ResultRow[];
}

// What a launch was made from. The setup form stays editable afterwards, so
// the scoreboard, case detail and export read from this snapshot.
interface Launch {
  dataset: string;
  system: string;
  grader: GraderKind;
  cases: EvalCase[];
  runs: { id: string; model: string; promptLabel: string | null; status: Run["status"] }[];
}

const MAX_CASES = 20; // the server's cap for public runs (MAX_PUBLIC_CASES)
const POLL_MS = 2000;

// The v1 history moves to the server once per page load, also when React's
// Strict Mode runs effects twice in development. The server side is
// idempotent anyway; this saves a request.
let legacyImport: Promise<number> | undefined;

async function importLegacyHistory(): Promise<number> {
  const runs = loadLegacyRuns();
  if (runs.length === 0) return 0;
  const res = await fetch("/api/runs/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs }),
  });
  // Keep the old history on failure; the next visit tries again.
  if (!res.ok) return 0;
  const data: { imported: { runs: { id: string }[] }[] } = await res.json();
  addToHistory(data.imported.flatMap((i) => i.runs.map((r) => r.id)));
  clearLegacyRuns();
  return data.imported.length;
}

export default function Home() {
  const [datasetIdx, setDatasetIdx] = useState(0); // index into SAMPLES, or -1 = custom
  const [customText, setCustomText] = useState("");
  const [system, setSystem] = useState(SAMPLES[0].system);
  const [grader, setGrader] = useState<GraderKind>(SAMPLES[0].grader);
  const [selectedModels, setSelectedModels] = useState<string[]>([
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
  ]);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [live, setLive] = useState<Record<string, LiveRun>>({});
  const [launching, setLaunching] = useState(false);
  const [runError, setRunError] = useState("");
  const [detail, setDetail] = useState<{ runId: string; idx: number } | null>(null);
  const [history, setHistory] = useState<HistoryRun[] | null>(null); // null until loaded
  const [historyError, setHistoryError] = useState("");
  const [notice, setNotice] = useState("");
  const [diffPick, setDiffPick] = useState<string[]>([]); // up to 2 run ids

  const cases: EvalCase[] = useMemo(() => {
    if (datasetIdx >= 0) return SAMPLES[datasetIdx].cases;
    return parseCustomCases(customText, MAX_CASES);
  }, [datasetIdx, customText]);

  const running = launch !== null && launch.runs.some((r) => !isFinished(live[r.id]?.run.status ?? r.status));

  async function refreshHistory() {
    const ids = loadHistory();
    if (ids.length === 0) {
      setHistory([]);
      return;
    }
    try {
      const res = await fetch(`/api/runs?ids=${ids.join(",")}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const runs: HistoryRun[] = data.runs;
      const found = new Set(runs.map((r) => r.id));
      forgetRuns(ids.filter((id) => !found.has(id)));
      setHistory(runs);
      setHistoryError("");
    } catch (err) {
      setHistoryError(`Could not load your runs: ${(err as Error).message}`);
    }
  }

  // On first load: move any v1 history to the server, then load the list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const moved = await (legacyImport ??= importLegacyHistory().catch(() => 0));
      if (cancelled) return;
      if (moved > 0) {
        setNotice(`Moved ${moved} saved run${moved === 1 ? "" : "s"} from this browser to the server.`);
      }
      await refreshHistory();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll every run of the current launch until all have finished. Each run is
  // fetched at least once, so a run that failed to queue shows its error.
  useEffect(() => {
    if (!launch) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = new Set(launch.runs.map((r) => r.id));

    async function tick() {
      await Promise.all(
        [...open].map(async (id) => {
          try {
            const res = await fetch(`/api/runs/${id}`, { cache: "no-store" });
            if (!res.ok) return; // try again on the next tick
            const data: LiveRun = await res.json();
            if (cancelled) return;
            setLive((prev) => ({ ...prev, [id]: data }));
            if (isFinished(data.run.status)) open.delete(id);
          } catch {
            // a network blip; the next tick retries
          }
        }),
      );
      if (cancelled) return;
      if (open.size > 0) timer = setTimeout(tick, POLL_MS);
      else refreshHistory();
    }
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [launch]);

  function pickDataset(idx: number) {
    if (launching) return;
    setDatasetIdx(idx);
    if (idx >= 0) {
      setSystem(SAMPLES[idx].system);
      setGrader(SAMPLES[idx].grader);
    }
  }

  async function runAll() {
    if (launching || running || cases.length === 0 || selectedModels.length === 0) return;
    setLaunching(true);
    setRunError("");
    setDetail(null);

    const dataset = datasetIdx >= 0 ? SAMPLES[datasetIdx].name : "Custom dataset";
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dataset,
          source: datasetIdx >= 0 ? "sample" : "custom",
          grader,
          cases,
          models: selectedModels,
          prompts: [{ system }],
        }),
      });
      // A platform error page (e.g. a function timeout) isn't JSON.
      const data = await res.json().catch(() => null);
      if (!data?.runs) throw new Error(data?.error ?? `HTTP ${res.status}`);
      // 502: the runs exist but some couldn't be queued; show the rest.
      if (data.error) setRunError(data.error);
      setLive({});
      setLaunch({ dataset, system, grader, cases, runs: data.runs });
      addToHistory(data.runs.map((r: { id: string }) => r.id));
      refreshHistory();
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  function exportJson() {
    if (!launch) return;
    const payload = {
      dataset: launch.dataset,
      system: launch.system,
      grader: launch.grader,
      cases: launch.cases,
      runs: launch.runs.map((r) => live[r.id] ?? { run: r }),
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

  const detailResult = detail ? live[detail.runId]?.results.find((r) => r.position === detail.idx) : undefined;
  const detailRun = detail ? launch?.runs.find((r) => r.id === detail.runId) : undefined;
  const picked = (history ?? []).filter((r) => diffPick.includes(r.id));
  // Baseline = the older run.
  const [base, next] = [...picked].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <main className="min-h-screen">
      <SiteHeader>
        <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-chalk-dim">
          Run a dataset against Claude models, grade every answer — exact match or
          LLM judge — and compare accuracy, latency, and cost.
        </p>
      </SiteHeader>

      <div className="mx-auto max-w-4xl px-6 pb-24">
        {notice && (
          <p role="status" className="mt-6 rounded-md border border-board/30 bg-board/5 px-4 py-3 text-sm text-board">
            {notice}
          </p>
        )}

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
                      disabled={launching}
                      onClick={() => pickDataset(i)}
                    >
                      {s.name}
                    </Chip>
                  ))}
                  <Chip active={datasetIdx === -1} disabled={launching} onClick={() => pickDataset(-1)}>
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
                      {shortModel(m)}
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
                disabled={launching || running || cases.length === 0 || selectedModels.length === 0}
                className="w-full rounded-lg bg-board px-4 py-2.5 text-sm font-semibold text-chalk transition hover:bg-[#1d4a40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board disabled:cursor-not-allowed disabled:opacity-40"
              >
                {launching
                  ? "Starting…"
                  : running
                    ? "Running…"
                    : `Run ${cases.length * selectedModels.length || ""} tests`}
              </button>
              <p className="text-[12px] leading-snug text-muted">
                Runs happen on the server: you can close the tab and come back.
              </p>
            </div>
          </div>
        </section>

        {runError && (
          <p role="alert" className="mt-6 rounded-md border border-fail/40 bg-fail/5 px-4 py-3 text-sm text-fail">
            {runError}
          </p>
        )}

        {/* Results — empty state invites the first run */}
        {!launch && (
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
        {launch && (
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
              {launch.runs.map((r) => {
                const lr = live[r.id];
                const status = lr?.run.status ?? r.status;
                const summary = lr?.summary;
                const byPosition = new Map((lr?.results ?? []).map((x) => [x.position, x]));
                const working = workingOn(launch.cases.length, byPosition, status);
                const rate = summary ? passRate(summary) : null;
                return (
                  <div key={r.id} className="rounded-xl border border-line bg-card p-5">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <span className="w-40 font-mono text-[13px] font-medium">{shortModel(r.model)}</span>
                      <span className="font-display text-3xl font-bold tabular-nums">
                        {rate === null ? "—" : `${rate}%`}
                      </span>
                      {/* Answer bubbles — the signature: one per case, filled as graded */}
                      <div
                        className="flex flex-wrap gap-1"
                        role="img"
                        aria-label={summary ? `${summary.passed} of ${summary.graded} passed` : "no results yet"}
                      >
                        {launch.cases.map((_, idx) => {
                          const result = byPosition.get(idx);
                          const state = cellState(result, working.has(idx));
                          return (
                            <button
                              key={idx}
                              onClick={() => result && setDetail({ runId: r.id, idx })}
                              title={`case ${idx + 1}: ${CELL_LABEL[state]}`}
                              className={`h-5 w-5 rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-board ${CELL_CLASS[state]} ${result ? "cursor-pointer hover:opacity-80" : ""}`}
                            />
                          );
                        })}
                      </div>
                      <span className="ml-auto font-mono text-[12px] text-muted">
                        {summary?.avgLatencyMs ? `${summary.avgLatencyMs} ms avg` : ""}
                        {summary?.costUsd ? ` · $${summary.costUsd.toFixed(4)}` : ""}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
                      <span className={status === "failed" ? "text-fail" : "text-muted"}>
                        {STATUS_LABEL[status]}
                        {status === "running" && summary && ` · ${summary.done} of ${launch.cases.length}`}
                        {lr?.run.error && ` · ${lr.run.error}`}
                      </span>
                      <Link
                        href={`/runs/${r.id}`}
                        target="_blank"
                        className="ml-auto font-medium text-board underline-offset-4 hover:underline"
                      >
                        Share link ↗
                      </Link>
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
        {launch && detail && detailRun && detailResult && (
          <section className="mt-8 rounded-xl border border-board/30 bg-card p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-display text-base font-semibold">
                Case {detail.idx + 1} · {shortModel(detailRun.model)} —{" "}
                {detailResult.pass === null ? (
                  <span className="text-fail">Error</span>
                ) : (
                  <span className={detailResult.pass ? "text-pass" : "text-fail"}>
                    {detailResult.pass ? "Pass" : "Fail"}
                  </span>
                )}
              </h3>
              <button
                onClick={() => setDetail(null)}
                className="text-[13px] font-medium text-muted transition hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
              >
                Close
              </button>
            </div>
            <div className="mt-4">
              <CaseDetail
                input={launch.cases[detail.idx]?.input ?? ""}
                expected={launch.cases[detail.idx]?.expected ?? ""}
                result={detailResult}
              />
            </div>
          </section>
        )}

        {/* Run history + diff */}
        {(historyError || (history && history.length > 0)) && (
          <section className="mt-14">
            <h2 className="font-display text-xl font-semibold">Your runs</h2>
            <p className="mt-1 text-[13px] text-muted">
              Pick two runs of the same dataset to compare them case by case.
            </p>
            {historyError && <p className="mt-3 text-[13px] text-fail">{historyError}</p>}
            <ul className="mt-4 space-y-2">
              {(history ?? []).map((run) => {
                const isPicked = diffPick.includes(run.id);
                const rate = passRate(run.summary);
                return (
                  <li
                    key={run.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-4 py-2.5 font-mono text-[12px] ${
                      isPicked ? "border-board bg-board/5" : "border-line bg-card"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isPicked}
                      onChange={() =>
                        setDiffPick((prev) =>
                          isPicked ? prev.filter((id) => id !== run.id) : [...prev, run.id].slice(-2),
                        )
                      }
                      className="h-3.5 w-3.5 accent-[#14332c]"
                      aria-label="select run for diff"
                    />
                    <Link href={`/runs/${run.id}`} className="text-ink underline-offset-4 hover:underline">
                      {run.datasetName}
                    </Link>
                    <span className="text-muted">{formatWhen(run.createdAt)}</span>
                    <span className="text-muted">{run.grader}</span>
                    {run.importedFrom && <span className="text-muted">imported</span>}
                    <span className="ml-auto text-muted">
                      {shortModel(run.model)}
                      {run.promptLabel && ` · ${run.promptLabel}`} ·{" "}
                      {isFinished(run.status) && rate !== null ? `${rate}%` : STATUS_LABEL[run.status]}
                    </span>
                    <button
                      onClick={() => {
                        removeFromHistory(run.id);
                        setHistory((prev) => (prev ?? []).filter((r) => r.id !== run.id));
                        setDiffPick((prev) => prev.filter((id) => id !== run.id));
                      }}
                      className="text-muted transition hover:text-fail focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
                      aria-label="remove from this list"
                      title="Remove from this list (the run stays reachable by its link)"
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>

            {base && next && (
              base.datasetId === next.datasetId ? (
                <Link
                  href={`/diff?a=${base.id}&b=${next.id}`}
                  className="mt-4 inline-block rounded-lg bg-board px-4 py-2 text-sm font-semibold text-chalk transition hover:bg-[#1d4a40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
                >
                  Compare {shortModel(base.model)} → {shortModel(next.model)} case by case
                </Link>
              ) : (
                <p className="mt-4 rounded-md border border-line bg-card px-4 py-3 text-[13px] text-muted">
                  These runs used different cases, so a case-by-case comparison isn&apos;t meaningful.
                  Pick two runs of the same dataset.
                </p>
              )
            )}
          </section>
        )}

        <footer className="mt-20 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-5 text-[12px] text-muted">
          <span>Runs are stored on the server; this browser remembers which ones are yours.</span>
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
