type ContentItem = {
  title: string;
  description: string;
  meta?: string;
};

type ContentGridProps = {
  items: ReadonlyArray<ContentItem>;
};

export function ContentGrid({ items }: ContentGridProps) {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {items.map((item) => (
        <article
          key={item.title}
          className="rounded-2xl border border-border bg-surface p-6 shadow-sm transition hover:bg-elevated"
        >
          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
            <p className="text-sm leading-6 text-text-secondary">{item.description}</p>
            {item.meta ? (
              <p className="text-sm font-medium text-primary">{item.meta}</p>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
