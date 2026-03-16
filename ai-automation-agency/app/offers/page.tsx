import { ContentGrid } from "@/components/content-grid";
import { PageHero } from "@/components/page-hero";
import { siteConfig } from "@/lib/site";

export default function OffersPage() {
  const page = siteConfig.pages.offers;

  return (
    <>
      <PageHero eyebrow={page.eyebrow} title={page.title} description={page.description} />
      <section className="section-shell pb-16">
        <ContentGrid items={page.items} />
      </section>
    </>
  );
}
