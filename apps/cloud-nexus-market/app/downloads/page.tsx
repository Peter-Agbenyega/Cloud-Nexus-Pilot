import { PageHero } from "@/components/page-hero";

export default function DownloadsPage() {
  return (
    <>
      <PageHero
        eyebrow="Downloads"
        title="Reserve this area for customer download access."
        description="As checkout and accounts are added, this route can become the post-purchase delivery center."
      />
      <section className="section-shell pb-16">
        <div className="panel p-8">
          <div className="grid gap-4 md:grid-cols-3">
            {[
              "Order history",
              "License access",
              "Download queue",
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
