import Link from "next/link";
import { ContentGrid } from "@/components/content-grid";
import { siteConfig } from "@/lib/site";

export default function HomePage() {
  return (
    <>
      <section className="section-shell py-16 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <span className="pill">{siteConfig.home.eyebrow}</span>
            <h1 className="mt-6 max-w-4xl text-5xl font-semibold tracking-tight text-foreground lg:text-7xl">
              {siteConfig.home.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-text-secondary">{siteConfig.home.description}</p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href={siteConfig.cta.href} className="rounded-full bg-primary px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-hover">
                {siteConfig.cta.label}
              </Link>
              <Link
                href="/workspace?demo=true"
                className="rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-elevated"
              >
                Watch Live Demo
              </Link>
              <Link href={siteConfig.mainNav[0].href} className="rounded-full border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-elevated">
                Explore
              </Link>
            </div>
          </div>
          <div className="panel p-8">
            <div className="grid gap-4">
              {siteConfig.home.stats.map((item) => (
                <div key={item.title} className="rounded-2xl border border-border bg-subtle p-5">
                  <p className="text-sm font-semibold text-primary">{item.meta}</p>
                  <h2 className="mt-2 text-xl font-semibold text-foreground">{item.title}</h2>
                  <p className="mt-2 text-sm leading-7 text-text-secondary">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section-shell pb-16">
        <div className="mb-8">
          <span className="pill">Why this starter works</span>
          <h2 className="mt-4 text-3xl font-semibold text-foreground">Reusable patterns with room to scale.</h2>
        </div>
        <ContentGrid items={siteConfig.home.highlights} />
      </section>

      {/* Version marker for deployment verification */}
      <div className="fixed bottom-3 right-3 text-xs text-text-disabled/60 select-none">
        v2.0
      </div>
    </>
  );
}
