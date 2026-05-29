import { ContentGrid } from "@/components/content-grid";
import { PageHero } from "@/components/page-hero";
import { siteConfig } from "@/lib/site";

export default function CategoriesPage() {
  return (
    <>
      <PageHero
        eyebrow="Categories"
        title="Explore the storefront by product family."
        description="Category navigation keeps the market organized as the catalog grows."
      />
      <section className="section-shell pb-16">
        <ContentGrid items={siteConfig.categories} />
      </section>
    </>
  );
}
