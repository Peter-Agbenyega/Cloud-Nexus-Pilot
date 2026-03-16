import Link from "next/link";

type ContentItem = {
  title: string;
  description: string;
  href?: string;
  meta?: string;
};

type ContentGridProps = {
  items: ContentItem[];
};

export function ContentGrid({ items }: ContentGridProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <article key={item.title} className="panel p-6">
          {item.meta ? <p className="text-sm font-medium text-primary">{item.meta}</p> : null}
          <h3 className="mt-3 text-xl font-semibold text-slate-950">{item.title}</h3>
          <p className="mt-3 text-sm leading-7 text-slate-600">{item.description}</p>
          {item.href ? (
            <Link href={item.href} className="mt-5 inline-flex text-sm font-semibold text-slate-950">
              Explore
            </Link>
          ) : null}
        </article>
      ))}
    </div>
  );
}
