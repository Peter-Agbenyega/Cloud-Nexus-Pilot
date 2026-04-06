import { AppShell } from "@/components/app-shell";
import { ReadyStateLaunchPanel } from "@/components/ready-state-launch-panel";
import { SessionWorkspaceShell } from "@/components/session-workspace-shell";

const nav = [
  { label: "Cockpit", href: "/workspace" },
  { label: "Transcripts", href: "/transcripts" },
  { label: "Prompt Library", href: "/prompt-library" },
  { label: "Pricing", href: "/pricing" },
];

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams?: Promise<{ demo?: string }>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const isDemoMode = resolvedSearchParams.demo === "true";

  if (isDemoMode) {
    return (
      <AppShell
        title="Workspace Demo"
        description="A deterministic browser-local workspace demo for a recruiter-style live call scenario."
        nav={nav}
      >
        <div className="rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">
              Demo workspace
            </span>
            <p className="text-xs text-slate-500">
              Recruiter call • browser-local runtime • preloaded answer direction
            </p>
          </div>
        </div>
        <SessionWorkspaceShell demoMode />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Live Call Copilot"
      description="Real-time transcription and response guidance for your conversations."
      nav={nav}
    >
      <ReadyStateLaunchPanel primaryActionLabel="Start Live Copilot" />
    </AppShell>
  );
}
