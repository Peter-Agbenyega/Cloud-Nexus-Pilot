import { ContentGrid } from "@/components/content-grid";
import { PageHero } from "@/components/page-hero";
import { siteConfig } from "@/lib/site";

export default function PricingPage() {
  const page = siteConfig.pages.pricing;

  return (
    <>
      <PageHero eyebrow={page.eyebrow} title={page.title} description={page.description} />
      <section className="section-shell pb-16">
        <p className="mb-6 text-sm text-slate-500">Proposed pricing only. Checkout, subscriptions, and paid entitlements are not available yet.</p>
        <ContentGrid items={page.items} />
      </section>
    </>
  );
}
