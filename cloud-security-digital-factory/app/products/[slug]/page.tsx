import { notFound } from "next/navigation";
import { siteConfig } from "@/lib/site";

type ProductDetailPageProps = {
  params: Promise<{ slug: string }>;
};

export default async function ProductDetailPage({ params }: ProductDetailPageProps) {
  const { slug } = await params;
  const product = siteConfig.products.find((item) => item.slug === slug);

  if (!product) {
    notFound();
  }

  return (
    <section className="section-shell py-16">
      <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="panel p-8">
          <span className="pill">{product.format}</span>
          <h1 className="mt-6 text-4xl font-semibold text-slate-950">{product.name}</h1>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">{product.summary}</p>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {[
              "Implementation notes",
              "Suggested use cases",
              "Update policy",
              "License terms",
            ].map((item) => (
              <div key={item} className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
                {item}
              </div>
            ))}
          </div>
        </div>
        <aside className="panel p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Price</p>
          <p className="mt-3 text-4xl font-semibold text-slate-950">{product.price}</p>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            Connect this panel to your checkout and digital delivery workflow when you are ready to sell live inventory.
          </p>
          <button className="mt-8 w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
            Checkout coming soon
          </button>
        </aside>
      </div>
    </section>
  );
}
