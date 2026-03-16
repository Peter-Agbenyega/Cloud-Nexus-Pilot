import Link from "next/link";

type AppShellProps = {
  title: string;
  description: string;
  nav: { label: string; href: string }[];
  children: React.ReactNode;
};

export function AppShell({ title, description, nav, children }: AppShellProps) {
  return (
    <div className="section-shell py-16">
      <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
        <aside className="panel p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Workspace</p>
          <h1 className="mt-3 text-2xl font-semibold text-slate-950">{title}</h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">{description}</p>
          <nav className="mt-8 flex flex-col gap-3">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="space-y-6">{children}</div>
      </div>
    </div>
  );
}
