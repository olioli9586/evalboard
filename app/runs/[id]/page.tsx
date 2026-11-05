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
import { judgeAgreement, type Agreement } from "@/lib/agreement";
import { getPool } from "@/lib/db";
import { passRate } from "@/lib/diff";
import { paginate } from "@/lib/paginate";
import { getDataset, getRun, listCases, listGroupRuns, listResults, runSummary } from "@/lib/store";
import { isUuid } from "@/lib/uuid";

// The share page for one run, read straight from the database. Anyone with
// the link can open it; the random id is what keeps it private.

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string; show?: string }>;
};

// Cases listed per page. The bubbles cover the whole run, but listing every
// case's details made a 3,080-case run's page about 12 MB, sent again on each
// refresh while it runs.
const CASES_PER_PAGE = 100;

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

export default async function RunPage({ params, searchParams }: Props) {
  const data = await loadRun((await params).id);
  if (!data) notFound();
  const { run, dataset, cases, results, summary, others } = data;
  const byPosition = new Map(results.map((r) => [r.position, r]));
  const working = workingOn(cases.length, byPosition, run.status);
  const rate = passRate(summary);
  const agreement = run.grader === "judge" ? judgeAgreement(results) : null;

  // The list shows one page of all cases, of the failed and errored ones, or
  // of the ones where the judge and a hand label disagree.
  const query = await searchParams;
  const show = query.show === "failed" || (query.show === "disagree" && agreement) ? query.show : undefined;
  const failed = cases.filter((c) => {
    const r = byPosition.get(c.position);
    return r !== undefined && r.pass !== true;
  });
  const disagreed = cases.filter((c) => {
    const r = byPosition.get(c.position);
    return r != null && r.pass !== null && r.humanPass != null && r.pass !== r.humanPass;
  });
  const listed = show === "failed" ? failed : show === "disagree" ? disagreed : cases;
  const { page, pages, start, items: shown } = paginate(listed, query.page, CASES_PER_PAGE);
  // A bubble opens its case on the unfiltered page that lists it.
  const paged = show !== undefined || cases.length > CASES_PER_PAGE;
  const caseHref = (position: number) =>
    `${paged ? `?page=${Math.floor(position / CASES_PER_PAGE) + 1}` : ""}#case-${position + 1}`;
  const bubbleSize = cases.length > 500 ? "h-3 w-3" : "h-5 w-5";

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
                  href={caseHref(c.position)}
                  title={`case ${c.position + 1}: ${CELL_LABEL[state]}`}
                  className={`bubble ${bubbleSize} ${CELL_CLASS[state]}`}
                />
              );
            })}
          </div>

          {run.grader === "judge" && !agreement && summary.graded > 0 && (
            <p className="mt-4 text-[13px]">
              <Link href={`/runs/${run.id}/label`} className="font-medium text-board underline-offset-4 hover:underline">
                Hand-label this run to check the judge (admin) →
              </Link>
            </p>
          )}

          {run.systemPrompt && (
            <details className="mt-5 text-[13px]">
              <summary className="cursor-pointer font-semibold">System prompt</summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-desk px-3 py-2 font-mono text-[13px]">{run.systemPrompt}</pre>
            </details>
          )}
        </section>

        {agreement && <AgreementPanel runId={run.id} a={agreement} disagreed={disagreed.length} />}

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
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <h2 className="font-display text-xl font-semibold">Cases</h2>
            <nav className="flex gap-4 text-[13px]" aria-label="Which cases">
              <FilterLink active={!show} href={`/runs/${run.id}`}>
                All ({cases.length})
              </FilterLink>
              <FilterLink active={show === "failed"} href={`/runs/${run.id}?show=failed`}>
                Failed or errored ({failed.length})
              </FilterLink>
              {agreement && (
                <FilterLink active={show === "disagree"} href={`/runs/${run.id}?show=disagree`}>
                  Judge and hand label disagree ({disagreed.length})
                </FilterLink>
              )}
            </nav>
            {listed.length > CASES_PER_PAGE && (
              <span className="font-mono text-[12px] text-muted">
                {start + 1}–{start + shown.length} of {listed.length}
              </span>
            )}
          </div>
          {shown.length === 0 && (
            <p className="mt-4 text-[13px] text-muted">
              {show === "disagree" ? "The judge agreed with every hand label." : "No failed or errored cases yet."}
            </p>
          )}
          <ol className="mt-4 space-y-2">
            {shown.map((c) => {
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
          <Pager base={`/runs/${run.id}`} page={page} pages={pages} show={show} />
        </section>
      </div>
    </main>
  );
}

// The judge's verdicts against the hand labels: kappa with its interval, raw
// agreement, and the 2x2 table they come from.
function AgreementPanel({ runId, a, disagreed }: { runId: string; a: Agreement; disagreed: number }) {
  const cell = "border border-line px-3 py-1.5 text-right tabular-nums";
  return (
    <section className="mt-6 rounded-xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold">Judge vs hand labels</h2>
        <Link href={`/runs/${runId}/label`} className="text-[13px] font-medium text-board underline-offset-4 hover:underline">
          Label more →
        </Link>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="font-display text-3xl font-bold tabular-nums">
          κ {a.kappa === null ? "—" : a.kappa.toFixed(2)}
        </span>
        <span className="font-mono text-[12px] text-muted">
          {a.ci95 && `Cohen's kappa, 95% CI ${a.ci95[0].toFixed(2)} to ${a.ci95[1].toFixed(2)} · `}
          agreed on {a.agreed} of {a.labeled} labeled ({Math.round((a.agreed / a.labeled) * 100)}%)
        </span>
      </div>
      <table className="mt-4 font-mono text-[12px]">
        <thead>
          <tr>
            <th />
            <th className={`${cell} font-semibold`}>Hand: pass</th>
            <th className={`${cell} font-semibold`}>Hand: fail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th className={`${cell} text-left font-semibold`}>Judge: pass</th>
            <td className={cell}>{a.bothPass}</td>
            <td className={cell}>{a.judgeOnlyPass}</td>
          </tr>
          <tr>
            <th className={`${cell} text-left font-semibold`}>Judge: fail</th>
            <td className={cell}>{a.humanOnlyPass}</td>
            <td className={cell}>{a.bothFail}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3 text-[13px] text-muted">
        {a.kappa === null
          ? "Both gave every labeled case the same verdict, so kappa is undefined."
          : "Kappa counts agreement beyond chance: 1 is perfect, 0 is no better than chance."}{" "}
        The labels were made blind: the labeling page hides the judge&apos;s verdicts.
        {disagreed > 0 && (
          <>
            {" "}
            <Link href={`/runs/${runId}?show=disagree`} className="font-medium text-board underline-offset-4 hover:underline">
              Read the {disagreed} disagreement{disagreed === 1 ? "" : "s"} →
            </Link>
          </>
        )}
      </p>
    </section>
  );
}

function FilterLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return active ? (
    <span className="font-semibold" aria-current="page">
      {children}
    </span>
  ) : (
    <Link href={href} className="font-medium text-board underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

function Pager({ base, page, pages, show }: { base: string; page: number; pages: number; show?: string }) {
  if (pages <= 1) return null;
  const href = (p: number) => `${base}?${new URLSearchParams({ ...(show && { show }), page: String(p) })}`;
  const step = "font-medium text-board underline-offset-4 hover:underline";
  return (
    <nav className="mt-5 flex items-center gap-5 text-[13px]" aria-label="Pages">
      {page > 1 ? <Link href={href(page - 1)} className={step}>← Previous</Link> : <span className="text-muted">← Previous</span>}
      <span className="font-mono text-[12px] text-muted">
        Page {page} of {pages}
      </span>
      {page < pages ? <Link href={href(page + 1)} className={step}>Next →</Link> : <span className="text-muted">Next →</span>}
    </nav>
  );
}
