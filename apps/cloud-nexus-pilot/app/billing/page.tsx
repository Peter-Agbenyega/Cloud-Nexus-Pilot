import Link from "next/link";
import { PageHero } from "@/components/page-hero";

const billingHighlights = [
  {
    title: "Plan visibility",
    description: "Use this route to explain tiers, usage boundaries, and upgrade expectations clearly.",
  },
  {
    title: "Procurement readiness",
    description: "Reserve space for invoices, annual plans, and future enterprise buying flows.",
  },
  {
    title: "Safe placeholder",
    description: "No payment provider is wired yet, so this route stays informational until billing is integrated.",
  },
];

export default function BillingPage() {
  return (
    <>
      <PageHero
        eyebrow="Billing"
        title="Billing and plan management will live here."
        description="This route is prepared for plan details, upgrade actions, and subscription state once a real billing provider is selected."
      />
      <section className="section-shell pb-16">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="panel p-8">
            <h2 className="text-2xl font-semibold text-slate-950">What belongs on this page</h2>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {billingHighlights.map((item) => (
                <article
                  key={item.title}
                  className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                >
                  <h3 className="text-lg font-semibold text-slate-950">{item.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">{item.description}</p>
                </article>
              ))}
            </div>
          </div>
          <aside className="panel p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Current state</p>
            <h2 className="mt-3 text-2xl font-semibold text-slate-950">Placeholder by design</h2>
            <p className="mt-4 text-sm leading-7 text-slate-600">
              Billing provider wiring, checkout, customer portal access, and entitlement logic are
              intentionally deferred until the product contract is ready.
            </p>
            <div className="mt-8 flex flex-col gap-3">
              <Link
                href="/pricing"
                className="rounded-full bg-slate-950 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Review Pricing Page
              </Link>
              <Link
                href="/dashboard"
                className="rounded-full border border-slate-300 bg-white px-5 py-3 text-center text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
              >
                Return to Workspace
              </Link>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
