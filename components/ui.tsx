import Link from "next/link";
import type { Transition } from "@/lib/diff";
import { BATCH_SIZE } from "@/lib/eval";
import type { ResultRow, RunStatus } from "@/lib/store";

// Pieces shared by the home page (client) and the run and diff pages
// (server). Nothing here holds state, so it renders in either.

export function shortModel(model: string): string {
  return model.replace("claude-", "");
}

export function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="bg-board">
      <div className="mx-auto flex max-w-4xl flex-wrap items-end justify-between gap-x-8 gap-y-4 px-6 py-8">
        <div>
          <Link href="/" className="flex items-center gap-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-chalk">
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
              <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
              <span className="h-2.5 w-2.5 rounded-full bg-fail" />
              <span className="h-2.5 w-2.5 rounded-full bg-chalk" />
              <span className="h-2.5 w-2.5 rounded-full border border-chalk-dim" />
            </span>
            <span className="font-display text-3xl font-semibold text-chalk">Evalboard</span>
          </Link>
          {children}
        </div>
        <a
          href="https://github.com/olioli9586/evalboard"
          className="text-[13px] font-medium text-chalk-dim underline-offset-4 transition hover:text-chalk hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chalk"
        >
          View source
        </a>
      </div>
    </header>
  );
}

// One answer bubble per case: filled green or red once graded, outlined red
// when the case errored, pulsing while its run is working on it.
export type CellState = "pass" | "fail" | "error" | "working" | "waiting";

export function cellState(result: ResultRow | undefined, working: boolean): CellState {
  if (result) return result.pass === null ? "error" : result.pass ? "pass" : "fail";
  return working ? "working" : "waiting";
}

// Which cases to show as in progress. The worker runs the lowest positions
// without a result, BATCH_SIZE at a time, so this is those. It is an estimate:
// once part of a batch is done, the next cases shown here are still waiting
// for the batch to finish.
export function workingOn(total: number, done: { has(position: number): boolean }, status: RunStatus): Set<number> {
  const out = new Set<number>();
  for (let p = 0; status === "running" && p < total && out.size < BATCH_SIZE; p++) {
    if (!done.has(p)) out.add(p);
  }
  return out;
}

export const CELL_CLASS: Record<CellState, string> = {
  pass: "cell-pop bg-pass",
  fail: "cell-pop bg-fail",
  error: "border-2 border-fail bg-fail/10",
  working: "animate-pulse bg-board/30",
  waiting: "border border-line",
};

export const CELL_LABEL: Record<CellState, string> = {
  pass: "pass",
  fail: "fail",
  error: "error",
  working: "running",
  waiting: "waiting",
};

export const TRANSITION_STYLE: Record<Transition, { cls: string; label: string }> = {
  "pass-pass": { cls: "bg-pass/55", label: "pass → pass" },
  "fail-fail": { cls: "bg-line", label: "fail → fail" },
  fixed: { cls: "bg-board", label: "fixed" },
  regressed: { cls: "bg-fail", label: "regressed" },
  ungraded: { cls: "border border-dashed border-line", label: "not graded" },
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
};

export function isFinished(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

// The server renders in UTC, so its pages say so; the browser uses local time.
export function formatWhen(date: string | Date, utc = false): string {
  const text = new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(utc && { timeZone: "UTC" }),
  });
  return utc ? `${text} UTC` : text;
}

export function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold text-muted">{label}</dt>
      <dd className={`mt-1 whitespace-pre-wrap leading-relaxed ${mono ? "font-mono text-[13px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

// v1 didn't save expected answers for custom datasets, so imported cases may
// have none.
export function expectedText(expected: string): React.ReactNode {
  return expected || <span className="text-muted">Not recorded (imported from v1 history)</span>;
}

// Input, expected answer, and what the run made of the case.
export function CaseDetail({ input, expected, result }: { input: string; expected: string; result: ResultRow | null }) {
  return (
    <dl className="space-y-3 text-[14px]">
      <DetailRow label="Input" value={input} />
      <DetailRow label="Expected" value={expectedText(expected)} />
      <CaseAnswer result={result} />
    </dl>
  );
}

// What one run made of a case: its output and verdict, or why it errored.
// Renders <dt>/<dd> pairs, so it goes inside a <dl>.
export function CaseAnswer({ result }: { result: ResultRow | null }) {
  if (!result) return <DetailRow label="Output" value={<span className="text-muted">No result yet</span>} />;
  if (result.pass === null) return <DetailRow label="What went wrong" value={result.error ?? "Unknown error"} mono />;
  return (
    <>
      <DetailRow label="Output" value={result.output || <span className="text-muted">Not saved</span>} mono />
      {result.reasoning && <DetailRow label="Judge's reasoning" value={result.reasoning} />}
      {result.modelUsed && (
        <DetailRow
          label="Timing and cost"
          value={`${result.latencyMs} ms · ${result.inputTokens} in / ${result.outputTokens} out tokens · $${result.costUsd.toFixed(5)} · served by ${result.modelUsed}${result.attempts > 1 ? ` · ${result.attempts} attempts` : ""}`}
          mono
        />
      )}
    </>
  );
}
