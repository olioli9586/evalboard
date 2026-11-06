"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { DetailRow, expectedText } from "@/components/ui";

// One graded case as the labeler sees it: no judge verdict, on purpose.
export interface LabelItem {
  position: number;
  input: string;
  expected: string;
  output: string;
  humanPass: boolean | null;
}

// The admin token lives in sessionStorage, so it lasts for this tab and no
// longer. Read through useSyncExternalStore: the server renders without it,
// and the browser picks it up after hydration.
const TOKEN_KEY = "evalboard:admin-token";
const tokenListeners = new Set<() => void>();
const tokenStore = {
  subscribe(listener: () => void) {
    tokenListeners.add(listener);
    return () => void tokenListeners.delete(listener);
  },
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set(value: string | null) {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
    tokenListeners.forEach((listener) => listener());
  },
};

const BUTTON =
  "rounded-lg px-4 py-2 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const STEP = "text-[13px] font-medium text-board underline-offset-4 hover:underline disabled:text-muted disabled:no-underline";

export function Labeler({ runId, system, items }: { runId: string; system: string; items: LabelItem[] }) {
  const [labels, setLabels] = useState(() => new Map(items.map((i) => [i.position, i.humanPass])));
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((i) => i.humanPass === null)));
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const item = items[index];
  const labeled = [...labels.values()].filter((v) => v !== null).length;
  const current = labels.get(item.position) ?? null;

  // After labeling case `from`: the next unlabeled case (wrapping around), or
  // the next case once everything is labeled.
  function advance(next: Map<number, boolean | null>, from: number) {
    for (let step = 1; step <= items.length; step++) {
      const i = (from + step) % items.length;
      if (next.get(items[i].position) === null) return setIndex(i);
    }
    setIndex(Math.min(from + 1, items.length - 1));
  }

  async function save(pass: boolean | null) {
    if (!token || saving) return;
    const from = index;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/labels`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ position: item.position, pass }),
      });
      if (res.status === 401) {
        tokenStore.set(null);
        setError("That admin token was not accepted.");
        return;
      }
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error ?? `Could not save the label (HTTP ${res.status}).`);
        return;
      }
      const next = new Map(labels).set(item.position, pass);
      setLabels(next);
      if (pass !== null) advance(next, from);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  // P and F label the case; the arrow keys move between cases.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement) return;
      const key = e.key.toLowerCase();
      if (key === "p") save(true);
      else if (key === "f") save(false);
      else if (key === "arrowleft") setIndex((i) => Math.max(0, i - 1));
      else if (key === "arrowright") setIndex((i) => Math.min(items.length - 1, i + 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function submitToken(e: React.FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    tokenStore.set(value);
    setDraft("");
    setError(null);
  }

  return (
    <div className="mt-6 space-y-5">
      <section className="rounded-xl border border-line bg-card p-5 text-[14px] leading-relaxed">
        <p>
          Decide for each case whether the output is an acceptable answer, using the expected answer as the reference:
          the same meaning passes; missing the core point, wrong facts, or ignoring the task instructions fail. These
          are the judge&apos;s own instructions. Its verdicts are not on this page, so they can&apos;t sway you; the run
          page compares the two once you have labeled.
        </p>
        <p className="mt-2 text-[13px] text-muted">Keys: P pass, F fail, ← → move between cases.</p>
      </section>

      {!token && (
        <form onSubmit={submitToken} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-card p-5">
          <label className="flex-1 text-[13px] font-semibold">
            Admin token (labels are saved with it; kept for this tab only)
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              className="mt-1 block w-full rounded-md border border-line bg-desk px-3 py-2 font-mono text-[13px] font-normal"
            />
          </label>
          <button type="submit" className={`${BUTTON} bg-board text-chalk hover:bg-[#1d4a40] focus-visible:outline-board`}>
            Use token
          </button>
        </form>
      )}

      {labeled === items.length && (
        <p role="status" className="rounded-md border border-board/30 bg-board/5 px-4 py-3 text-sm text-board">
          All {items.length} cases labeled.{" "}
          <Link href={`/runs/${runId}`} className="font-semibold underline underline-offset-4">
            See how the judge did →
          </Link>
        </p>
      )}

      <div>
        <p className="font-mono text-[12px] text-muted">
          Case {index + 1} of {items.length} · {labeled} labeled
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {items.map((it, i) => {
            const v = labels.get(it.position);
            const fill = v === true ? "bg-pass" : v === false ? "bg-fail" : "border border-line";
            return (
              <button
                key={it.position}
                type="button"
                onClick={() => setIndex(i)}
                title={`case ${it.position + 1}: ${v === null ? "not labeled" : v ? "pass" : "fail"}`}
                aria-current={i === index ? "true" : undefined}
                className={`bubble h-5 w-5 ${fill} ${i === index ? "ring-2 ring-board ring-offset-2" : ""}`}
              />
            );
          })}
        </div>
      </div>

      <section className="rounded-xl border border-line bg-card p-6">
        <p className="font-mono text-[12px] text-muted">#{item.position + 1}</p>
        <dl className="mt-2 space-y-3 text-[14px]">
          {system && <DetailRow label="Task instructions" value={system} />}
          <DetailRow label="Input" value={item.input} />
          <DetailRow label="Expected" value={expectedText(item.expected)} />
          <DetailRow label="Output" value={item.output || <span className="text-muted">Empty</span>} mono />
        </dl>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => save(true)}
            disabled={!token || saving}
            aria-pressed={current === true}
            className={`${BUTTON} focus-visible:outline-pass ${current === true ? "bg-pass text-chalk" : "border border-pass text-pass hover:bg-pass/10"}`}
          >
            Pass (P)
          </button>
          <button
            type="button"
            onClick={() => save(false)}
            disabled={!token || saving}
            aria-pressed={current === false}
            className={`${BUTTON} focus-visible:outline-fail ${current === false ? "bg-fail text-chalk" : "border border-fail text-fail hover:bg-fail/10"}`}
          >
            Fail (F)
          </button>
          {current !== null && (
            <button type="button" onClick={() => save(null)} disabled={!token || saving} className={STEP}>
              Clear label
            </button>
          )}
          <span className="ml-auto flex gap-4">
            <button type="button" onClick={() => setIndex(index - 1)} disabled={index === 0} className={STEP}>
              ← Previous
            </button>
            <button type="button" onClick={() => setIndex(index + 1)} disabled={index === items.length - 1} className={STEP}>
              Next →
            </button>
          </span>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-fail">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
