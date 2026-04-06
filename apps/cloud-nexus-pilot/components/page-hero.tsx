type PageHeroProps = {
  eyebrow: string;
  title: string;
  description: string;
};

export function PageHero({ eyebrow, title, description }: PageHeroProps) {
  return (
    <section className="section-shell py-16">
      <div className="panel overflow-hidden">
        <div className="grid-pattern bg-grid px-8 py-14 lg:px-14">
          <span className="pill">{eyebrow}</span>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 lg:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">{description}</p>
        </div>
      </div>
    </section>
  );
}
