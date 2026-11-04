import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  CaseAnswer,
  DetailRow,
  expectedText,
  formatWhen,
  isFinished,
  runLabel,
  shortModel,
  SiteHeader,
  STATUS_LABEL,
  TRANSITION_STYLE,
} from "@/components/ui";
import { getPool } from "@/lib/db";
import { diffRuns, passRate, type Transition } from "@/lib/diff";
import { getDataset, getRun, listCases, listResults, runSummary, type Run } from "@/lib/store";
import { isUuid } from "@/lib/uuid";

// Two runs of the same dataset, case by case: what got fixed, what regressed.
// a is the baseline, b the run being judged against it.

export const metadata: Metadata = {
  title: "Compare runs · Evalboard",
  robots: { index: false },
};

export default async function DiffPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { a: idA, b: idB } = await searchParams;
  if (!isUuid(idA) || !isUuid(idB)) notFound();

  const db = getPool();
  const [runA, runB] = await Promise.all([getRun(db, idA), getRun(db, idB)]);
  if (!runA || !runB) notFound();

  if (runA.datasetId !== runB.datasetId) {
    return (
      <Shell>
        <section className="mt-8 rounded-xl border border-line bg-card p-6">
          <h1 className="font-display text-xl font-semibold">These runs used different cases</h1>
          <p className="mt-2 text-[14px] text-muted">
            A case-by-case comparison needs two runs of the same dataset. Open them on their own:
          </p>
          <ul className="mt-3 space-y-1 font-mono text-[13px]">
            <RunLink run={runA} />
            <RunLink run={runB} />
          </ul>
        </section>
      </Shell>
    );
  }

  const [dataset, cases, resultsA, resultsB, summaryA, summaryB] = await Promise.all([
    getDataset(db, runA.datasetId),
    listCases(db, runA.datasetId),
    listResults(db, idA),
    listResults(db, idB),
    runSummary(db, idA),
    runSummary(db, idB),
  ]);
  const { rows, counts } = diffRuns(cases, resultsA, resultsB);
  const rateA = passRate(summaryA);
  const rateB = passRate(summaryB);
  const delta = rateA !== null && rateB !== null ? rateB - rateA : null;
  const changed = rows.filter((r) => r.transition === "fixed" || r.transition === "regressed");
  const running = !isFinished(runA.status) || !isFinished(runB.status);

  return (
    <Shell>
      {running && <AutoRefresh />}
      <section className="mt-8 rounded-xl border border-line bg-card p-6">
        <h1 className="font-display text-2xl font-semibold">Comparing two runs of {dataset?.name}</h1>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <RunCard label="A (baseline)" run={runA} rate={rateA} />
          <RunCard label="B" run={runB} rate={rateB} />
        </div>
        <p className="mt-3 text-[13px]">
          <Link href={`/diff?a=${idB}&b=${idA}`} className="font-medium text-board underline-offset-4 hover:underline">
            Swap A and B
          </Link>
        </p>
        {runA.systemPrompt !== runB.systemPrompt && (
          <details className="mt-4 text-[13px]">
            <summary className="cursor-pointer font-medium text-board">The system prompt differs between these runs</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <pre className="whitespace-pre-wrap rounded-md bg-desk px-3 py-2 font-mono">{runA.systemPrompt || "(none)"}</pre>
              <pre className="whitespace-pre-wrap rounded-md bg-desk px-3 py-2 font-mono">{runB.systemPrompt || "(none)"}</pre>
            </div>
          </details>
        )}

        <div className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-display text-3xl font-bold tabular-nums">
            {rateA ?? "—"}% → {rateB ?? "—"}%
          </span>
          {delta !== null && (
            <span className={`font-mono text-[13px] ${delta > 0 ? "text-pass" : delta < 0 ? "text-fail" : "text-muted"}`}>
              {delta > 0 ? `+${delta}` : delta} pts
            </span>
          )}
          <span className="ml-auto font-mono text-[12px] text-muted">
            {counts.fixed > 0 && <span className="text-board">{counts.fixed} fixed</span>}
            {counts.fixed > 0 && counts.regressed > 0 && " · "}
            {counts.regressed > 0 && <span className="text-fail">{counts.regressed} regressed</span>}
            {counts.fixed === 0 && counts.regressed === 0 && "no case changed verdict"}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {rows.map((r) => (
            <a
              key={r.position}
              href={`#case-${r.position + 1}`}
              title={`case ${r.position + 1}: ${TRANSITION_STYLE[r.transition].label}`}
              className={`h-5 w-5 rounded-full hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-board ${TRANSITION_STYLE[r.transition].cls}`}
            />
          ))}
        </div>
        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-muted">
          {(Object.keys(TRANSITION_STYLE) as Transition[]).map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className={`h-3 w-3 rounded-full ${TRANSITION_STYLE[t].cls}`} />
              {TRANSITION_STYLE[t].label} ({counts[t]})
            </span>
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold">Cases that changed</h2>
        {changed.length === 0 ? (
          <p className="mt-3 text-[14px] text-muted">No case went from pass to fail or back.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {changed.map((r) => (
              <li key={r.position} id={`case-${r.position + 1}`} className="scroll-mt-4 rounded-xl border border-line bg-card p-5">
                <h3 className="text-[14px] font-semibold">
                  Case {r.position + 1} ·{" "}
                  <span className={r.transition === "fixed" ? "text-board" : "text-fail"}>{TRANSITION_STYLE[r.transition].label}</span>
                </h3>
                <dl className="mt-3 space-y-3 text-[14px]">
                  <DetailRow label="Input" value={r.input} />
                  <DetailRow label="Expected" value={expectedText(r.expected)} />
                </dl>
                <div className="mt-4 grid gap-5 border-t border-line pt-4 sm:grid-cols-2">
                  <div>
                    <p className="mb-2 font-mono text-[12px] text-muted">A · {shortModel(runA.model)}</p>
                    <dl className="space-y-3 text-[14px]">
                      <CaseAnswer result={r.a} />
                    </dl>
                  </div>
                  <div>
                    <p className="mb-2 font-mono text-[12px] text-muted">B · {shortModel(runB.model)}</p>
                    <dl className="space-y-3 text-[14px]">
                      <CaseAnswer result={r.b} />
                    </dl>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-4xl px-6 pb-24">
        <p className="mt-8 text-[13px]">
          <Link href="/" className="font-medium text-board underline-offset-4 hover:underline">
            ← Run your own eval
          </Link>
        </p>
        {children}
      </div>
    </main>
  );
}

function RunCard({ label, run, rate }: { label: string; run: Run; rate: number | null }) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <p className="text-[12px] font-semibold text-muted">{label}</p>
      <Link href={`/runs/${run.id}`} className="mt-1 block font-mono text-[14px] font-medium underline-offset-4 hover:underline">
        {runLabel(run)}
      </Link>
      <p className="mt-1 font-mono text-[12px] text-muted">
        {rate === null ? "—" : `${rate}%`} · {STATUS_LABEL[run.status]} · {formatWhen(run.createdAt, true)}
      </p>
    </div>
  );
}

function RunLink({ run }: { run: Run }) {
  return (
    <li>
      <Link href={`/runs/${run.id}`} className="underline-offset-4 hover:underline">
        {shortModel(run.model)} · {formatWhen(run.createdAt, true)}
      </Link>
    </li>
  );
}
