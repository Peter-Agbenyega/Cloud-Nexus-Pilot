import { ErrorBoundary } from "@/components/error-boundary";
import { ReadyStateLaunchPanel } from "@/components/ready-state-launch-panel";
import { SessionWorkspaceShell } from "@/components/session-workspace-shell";

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams?: Promise<{ demo?: string }>;
}) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const isDemoMode = resolvedSearchParams.demo === "true";

  if (isDemoMode) {
    return (
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 500, color: "#F0F0FF", marginBottom: 4 }}>
          Mock Interview
        </h1>
        <p style={{ fontSize: 13, color: "#6060A0", marginBottom: 24 }}>
          Practice with a simulated recruiter call scenario
        </p>
        <ErrorBoundary>
          <SessionWorkspaceShell demoMode />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 500, color: "#F0F0FF", marginBottom: 4 }}>
        Interview Copilot
      </h1>
      <p style={{ fontSize: 13, color: "#6060A0", marginBottom: 24 }}>
        Real-time transcription and AI-powered answer guidance
      </p>
      <ErrorBoundary>
        <ReadyStateLaunchPanel />
      </ErrorBoundary>
    </div>
  );
}
