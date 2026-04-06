import Link from "next/link";
import { PageHero } from "@/components/page-hero";

export default function BillingCancelPage() {
  return (
    <>
      <PageHero
        eyebrow="Billing Cancelled"
        title="Billing cancellation handling is reserved here."
        description="This route is ready for future cancellation and retry messaging once checkout exists."
      />
      <section className="section-shell pb-16">
        <div className="panel mx-auto max-w-3xl p-8">
          <h2 className="text-2xl font-semibold text-slate-950">Nothing was changed</h2>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Cloud Nexus Pilot does not have live billing wired yet. When billing is introduced,
            this route can explain what happened and offer a clean path back to plan selection.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/pricing"
              className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              View Pricing
            </Link>
            <Link
              href="/dashboard"
              className="rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              Return to Workspace
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
