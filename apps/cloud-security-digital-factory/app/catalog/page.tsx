import Link from "next/link";
import { PageHero } from "@/components/page-hero";
import { siteConfig } from "@/lib/site";

export default function CatalogPage() {
  return (
    <>
      <PageHero
        eyebrow="Catalog"
        title="Browse digital assets built for cloud and security operators."
        description="Merchandise templates, SOPs, and documentation kits in a format that feels operational, not generic."
      />
      <section className="section-shell pb-16">
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {siteConfig.products.map((product) => (
            <article key={product.slug} className="panel p-6">
              <p className="text-sm font-semibold text-primary">{product.format}</p>
              <h2 className="mt-3 text-2xl font-semibold text-slate-950">{product.name}</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">{product.summary}</p>
              <div className="mt-6 flex items-center justify-between">
                <span className="text-lg font-semibold text-slate-950">{product.price}</span>
                <Link href={`/products/${product.slug}`} className="rounded-full bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
                  View
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
