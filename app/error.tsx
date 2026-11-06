"use client";

// Shown when a page fails to render, for example when the database is
// unreachable. Server error details stay in the server logs.
export default function Error({ unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  return (
    <main className="mx-auto min-h-screen max-w-4xl px-6 pb-24">
      <section className="mt-12 rounded-xl border border-line bg-card p-6">
        <h1 className="font-display text-xl font-semibold">Something went wrong loading this page</h1>
        <p className="mt-2 text-[14px] text-muted">It may be a temporary database problem.</p>
        <button
          onClick={() => unstable_retry()}
          className="mt-4 rounded-lg bg-board px-4 py-2 text-sm font-semibold text-chalk transition hover:bg-[#1d4a40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-board"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
