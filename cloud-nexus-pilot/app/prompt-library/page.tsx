import { ContentGrid } from "@/components/content-grid";
import { PageHero } from "@/components/page-hero";
import { siteConfig } from "@/lib/site";

export default function PromptLibraryPage() {
  const page = siteConfig.pages.promptLibrary;

  return (
    <>
      <PageHero eyebrow={page.eyebrow} title={page.title} description={page.description} />
      <section className="section-shell pb-16">
        <ContentGrid items={page.items} />
      </section>
    </>
  );
}
