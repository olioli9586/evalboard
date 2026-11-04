import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  CaseDetail,
  CELL_CLASS,
  CELL_LABEL,
  cellState,
  formatWhen,
  isFinished,
  runLabel,
  shortModel,
  SiteHeader,
  STATUS_LABEL,
  workingOn,
} from "@/components/ui";
import { getPool } from "@/lib/db";
import { passRate } from "@/lib/diff";
import { getDataset, getRun, listCases, listGroupRuns, listResults, runSummary } from "@/lib/store";
import { isUuid } from "@/lib/uuid";

// The share page for one run, read straight from the database. Anyone with
// the link can open it; the random id is what keeps it private.

type Props = { params: Promise<{ id: string }> };

// cache() lets the page and its metadata share one set of queries.
const loadRun = cache(async (id: string) => {
  if (!isUuid(id)) return null;
  await connection(); // always render at request time: the run changes while it runs
  const db = getPool();
  const run = await getRun(db, id);
  if (!run) return null;
  const [dataset, cases, results, summary, group] = await Promise.all([
    getDataset(db, run.datasetId),
    listCases(db, run.datasetId),
    listResults(db, id),
    runSummary(db, id),
    listGroupRuns(db, run.groupId),
  ]);
  return { run, dataset, cases, results, summary, others: group.filter((r) => r.id !== id) };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadRun((await params).id);
  if (!data) return { title: "Run not found · Evalboard" };
  return {
    title: `${shortModel(data.run.model)} on ${data.dataset?.name ?? "a dataset"} · Evalboard`,
    robots: { index: false }, // share links are unlisted
  };
}

export default async function RunPage({ params }: Props) {
  const data = await loadRun((await params).id);
  if (!data) notFound();
  const { run, dataset, cases, results, summary, others } = data;
  const byPosition = new Map(results.map((r) => [r.position, r]));
  const working = workingOn(cases.length, byPosition, run.status);
  const rate = passRate(summary);

  return (
    <main className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-4xl px-6 pb-24">
        {!isFinished(run.status) && <AutoRefresh />}
        <p className="mt-8 text-[13px]">
          <Link href="/" className="font-medium text-board underline-offset-4 hover:underline">
            ← Run your own eval
          </Link>
        </p>

        <section className="mt-4 rounded-xl border border-line bg-card p-6">
          <h1 className="font-display text-2xl font-semibold">{dataset?.name}</h1>
          <p className="mt-1 font-mono text-[13px] text-muted">
            {shortModel(run.model)}
            {run.promptLabel && ` · prompt "${run.promptLabel}"`}
            {run.effort && ` · effort ${run.effort}`} · {run.grader === "exact" ? "exact match" : "LLM judge"} ·{" "}
            {formatWhen(run.createdAt, true)} · {STATUS_LABEL[run.status]}
          </p>

          {run.importedFrom && (
            <p className="mt-3 text-[13px] text-muted">
              Imported from browser history saved by the first version of Evalboard. Only pass/fail was kept: no
              outputs, latency or cost.
            </p>
          )}
          {run.status === "failed" && (
            <p role="alert" className="mt-4 rounded-md border border-fail/40 bg-fail/5 px-4 py-3 text-sm text-fail">
              {run.error ?? "The run failed."}
            </p>
          )}
          {!isFinished(run.status) && (
            <p className="mt-3 text-[13px] text-muted">
              {run.status === "queued" ? "Waiting for a worker…" : `Running: ${summary.done} of ${run.totalCases} cases done.`}
              {run.error && ` ${run.error}`} This page updates by itself.
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="font-display text-4xl font-bold tabular-nums">{rate === null ? "—" : `${rate}%`}</span>
            <span className="font-mono text-[12px] text-muted">
              {summary.passed} of {summary.graded} graded passed
              {summary.errored > 0 && ` · ${summary.errored} errored`}
              {summary.avgLatencyMs > 0 && ` · ${summary.avgLatencyMs} ms avg`}
              {summary.costUsd > 0 && ` · $${summary.costUsd.toFixed(4)}`}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap gap-1">
            {cases.map((c) => {
              const state = cellState(byPosition.get(c.position), working.has(c.position));
              return (
                <a
                  key={c.position}
                  href={`#case-${c.position + 1}`}
                  title={`case ${c.position + 1}: ${CELL_LABEL[state]}`}
                  className={`h-5 w-5 rounded-full hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-board ${CELL_CLASS[state]}`}
                />
              );
            })}
          </div>

          {run.systemPrompt && (
            <details className="mt-5 text-[13px]">
              <summary className="cursor-pointer font-semibold">System prompt</summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-desk px-3 py-2 font-mono text-[13px]">{run.systemPrompt}</pre>
            </details>
          )}
        </section>

        {others.length > 0 && (
          <section className="mt-6 rounded-xl border border-line bg-card p-5">
            <h2 className="font-display text-base font-semibold">Launched together</h2>
            <ul className="mt-3 space-y-2">
              {others.map((o) => {
                const r = passRate(o.summary);
                return (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px]">
                    <Link href={`/runs/${o.id}`} className="text-ink underline-offset-4 hover:underline">
                      {runLabel(o)}
                    </Link>
                    <span className="text-muted">{r === null ? STATUS_LABEL[o.status] : `${r}%`}</span>
                    <Link
                      href={`/diff?a=${run.id}&b=${o.id}`}
                      className="ml-auto font-sans text-[13px] font-medium text-board underline-offset-4 hover:underline"
                    >
                      Compare case by case →
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold">Cases</h2>
          <ol className="mt-4 space-y-2">
            {cases.map((c) => {
              const result = byPosition.get(c.position) ?? null;
              const state = cellState(result ?? undefined, working.has(c.position));
              return (
                <li key={c.position} id={`case-${c.position + 1}`} className="scroll-mt-4">
                  <details className="rounded-md border border-line bg-card px-4 py-2.5">
                    <summary className="flex cursor-pointer items-center gap-3 text-[13px]">
                      <span className={`h-3.5 w-3.5 shrink-0 rounded-full ${CELL_CLASS[state]}`} aria-hidden="true" />
                      <span className="w-14 shrink-0 font-mono text-muted">#{c.position + 1}</span>
                      <span className="truncate">{c.input}</span>
                      <span className="ml-auto shrink-0 font-mono text-[12px] text-muted">{CELL_LABEL[state]}</span>
                    </summary>
                    <div className="mt-3 border-t border-line pt-3">
                      <CaseDetail input={c.input} expected={c.expected} result={result} />
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </main>
  );
}
