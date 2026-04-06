import Link from "next/link";
import { PageHero } from "@/components/page-hero";

export default function BillingSuccessPage() {
  return (
    <>
      <PageHero
        eyebrow="Billing Success"
        title="Billing success handling is reserved here."
        description="Once a real provider is connected, this route can confirm checkout completion and guide users back into the workspace."
      />
      <section className="section-shell pb-16">
        <div className="panel mx-auto max-w-3xl p-8">
          <h2 className="text-2xl font-semibold text-slate-950">No live checkout is connected yet</h2>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            This page exists to complete route parity and future billing flow design. It should be
            wired only when a real provider, webhook path, and entitlement model are in place.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/dashboard"
              className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Go to Workspace
            </Link>
            <Link
              href="/billing"
              className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              Back to Billing
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
