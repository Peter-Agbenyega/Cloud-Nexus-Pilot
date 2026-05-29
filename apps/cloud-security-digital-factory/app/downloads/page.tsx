import { PageHero } from "@/components/page-hero";

export default function DownloadsPage() {
  return (
    <>
      <PageHero
        eyebrow="Downloads"
        title="Customer downloads and update delivery will live here."
        description="Keep this route reserved for signed-in delivery, receipts, product updates, and access management."
      />
      <section className="section-shell pb-16">
        <div className="panel p-8">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              "Recent purchases",
              "Version history",
              "License details",
            ].map((item) => (
              <div key={item} className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
