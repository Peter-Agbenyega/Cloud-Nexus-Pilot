import Link from "next/link";
import { PageHero } from "@/components/page-hero";

export default function SummaryPage() {
  return (
    <>
      <PageHero
        eyebrow="AI Summary"
        title="Summary workflows are staged and ready for your model pipeline."
        description="This placeholder page marks the handoff point for transcript parsing, prompt orchestration, and response rendering."
      />
      <section className="section-shell pb-16">
        <div className="panel p-8">
          <h2 className="text-2xl font-semibold text-slate-950">Suggested next implementation steps</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {[
              "Choose a summarization model and system prompt versioning strategy.",
              "Add transcript chunking, redaction, and retry logic.",
              "Persist structured outputs for recruiter, operator, or stakeholder views.",
            ].map((item) => (
              <div key={item} className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm leading-7 text-slate-700">
                {item}
              </div>
            ))}
          </div>
          <Link href="/prompt-library" className="mt-8 inline-flex rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
            Review prompt library
          </Link>
        </div>
      </section>
    </>
  );
}
