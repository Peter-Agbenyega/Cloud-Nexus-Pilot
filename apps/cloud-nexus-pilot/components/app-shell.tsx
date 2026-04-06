import Link from "next/link";

type AppShellProps = {
  title: string;
  description: string;
  nav: { label: string; href: string }[];
  children: React.ReactNode;
};

export function AppShell({ title, description, nav, children }: AppShellProps) {
  return (
    <div className="cockpit-theme section-shell py-10 lg:py-12">
      <div className="rounded-[2rem] border border-slate-700/70 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.10),transparent_30%),linear-gradient(180deg,rgba(15,23,42,0.94),rgba(2,6,23,0.98))] p-4 md:p-5">
        <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
          <aside className="h-fit rounded-3xl border border-slate-700 bg-slate-900/85 p-6 shadow-[0_18px_45px_rgba(2,6,23,0.45)] lg:sticky lg:top-20">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-cyan-300/90">
              Cloud Nexus Pilot
            </p>
            <h1 className="mt-3 text-3xl font-semibold leading-[1.15] tracking-[-0.02em] text-slate-50">
              {title}
            </h1>
            <p className="mt-4 text-sm font-normal leading-7 text-slate-300">{description}</p>
            <div className="mt-5 rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.1em] text-cyan-200">
                Primary Action
              </p>
              <p className="mt-2 text-sm font-medium text-slate-100">
                Start Call Copilot to enter live session mode.
              </p>
            </div>
            <nav className="mt-6 flex flex-col gap-2">
              {nav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-2xl border border-slate-700/80 bg-slate-900/60 px-4 py-3 text-sm font-medium tracking-[-0.01em] text-slate-200 transition hover:border-cyan-300/60 hover:bg-slate-900 hover:text-white"
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
