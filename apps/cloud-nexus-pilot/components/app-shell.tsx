import Link from "next/link";

type AppShellProps = {
  title: string;
  description: string;
  nav: { label: string; href: string }[];
  children: React.ReactNode;
};

export function AppShell({ title, description, nav, children }: AppShellProps) {
  return (
    <div className="section-shell py-10 lg:py-12">
      <div className="rounded-2xl border border-border/50 bg-surface p-4 md:p-5">
        <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
          <aside className="h-fit rounded-2xl border border-border bg-background p-6 shadow-soft lg:sticky lg:top-20">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-accent">
              Cloud Nexus Pilot
            </p>
            <h1 className="mt-3 text-3xl font-semibold leading-[1.15] tracking-[-0.02em] text-foreground">
              {title}
            </h1>
            <p className="mt-4 text-sm font-normal leading-7 text-text-secondary">{description}</p>
            <div className="mt-5 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-accent">
                Primary Action
              </p>
              <p className="mt-2 text-sm font-medium text-foreground">
                Start Call Copilot to enter live session mode.
              </p>
            </div>
            <nav className="mt-6 flex flex-col gap-2">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium tracking-[-0.01em] text-text-secondary transition hover:border-accent/60 hover:bg-elevated hover:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </aside>
          <div className="space-y-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
