import Link from "next/link";
import { SiteHeader } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-4xl px-6 pb-24">
        <section className="mt-8 rounded-xl border border-line bg-card p-6">
          <h1 className="font-display text-xl font-semibold">Nothing here</h1>
          <p className="mt-2 text-[14px] text-muted">
            This run doesn&apos;t exist, or the link was cut short. Run links look like
            /runs/ followed by a long id.
          </p>
          <p className="mt-4 text-[14px]">
            <Link href="/" className="font-medium text-board underline-offset-4 hover:underline">
              Run your own eval →
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
