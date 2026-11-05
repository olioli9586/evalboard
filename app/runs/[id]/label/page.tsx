import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Labeler, type LabelItem } from "@/components/labeler";
import { runLabel, SiteHeader } from "@/components/ui";
import { getPool } from "@/lib/db";
import { getDataset, getRun, listCases, listResults } from "@/lib/store";
import { isUuid } from "@/lib/uuid";

// Hand-labeling one LLM-judge run, to measure the judge against a person.
// The page sends the browser each graded case's input, expected answer and
// output, and never the judge's verdict or reasoning, so the labels are blind
// by construction. Saving a label needs the admin token.

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "Hand-label a run · Evalboard", robots: { index: false } };

export default async function LabelPage({ params }: Props) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  await connection();
  const db = getPool();
  const run = await getRun(db, id);
  if (!run) notFound();
  const [dataset, cases, results] = await Promise.all([
    getDataset(db, run.datasetId),
    listCases(db, run.datasetId),
    listResults(db, id),
  ]);
  const byPosition = new Map(cases.map((c) => [c.position, c]));
  const items: LabelItem[] = results
    .filter((r) => r.pass !== null)
    .map((r) => ({
      position: r.position,
      input: byPosition.get(r.position)?.input ?? "",
      expected: byPosition.get(r.position)?.expected ?? "",
      output: r.output,
      humanPass: r.humanPass,
    }));

  return (
    <main className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-4xl px-6 pb-24">
        <p className="mt-8 text-[13px]">
          <Link href={`/runs/${run.id}`} className="font-medium text-board underline-offset-4 hover:underline">
            ← Back to the run
          </Link>
        </p>
        <h1 className="mt-4 font-display text-2xl font-semibold">Hand-label: {dataset?.name}</h1>
        <p className="mt-1 font-mono text-[13px] text-muted">{runLabel(run)}</p>
        {run.grader !== "judge" ? (
          <p className="mt-6 text-sm text-muted">This run is graded by exact match, so there is no judge to check.</p>
        ) : items.length === 0 ? (
          <p className="mt-6 text-sm text-muted">No graded cases yet. Come back when the run has results.</p>
        ) : (
          <Labeler runId={run.id} system={run.systemPrompt} items={items} />
        )}
      </div>
    </main>
  );
}
