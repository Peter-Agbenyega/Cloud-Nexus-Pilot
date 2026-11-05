import { ErrorBoundary } from "@/components/error-boundary";
import { MockInterviewWorkbench } from "@/components/mock-interview-workbench";
import { ReadyStateLaunchPanel } from "@/components/ready-state-launch-panel";

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
        <h1 style={{ fontSize: 26, fontWeight: 650, color: "#F0F0FF", marginBottom: 4 }}>
          Mock Interview
        </h1>
        <p style={{ fontSize: 14, color: "#A8B6CD", marginBottom: 18 }}>
          Practice one question at a time with role-specific follow-ups
        </p>
        <ErrorBoundary>
          <MockInterviewWorkbench />
        </ErrorBoundary>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 650, color: "#F0F0FF", marginBottom: 4 }}>
        Interview Copilot
      </h1>
      <p style={{ fontSize: 14, color: "#A8B6CD", marginBottom: 18 }}>
        Stay with the conversation. Read your question and answer side by side.
      </p>
      <ErrorBoundary>
        <ReadyStateLaunchPanel />
      </ErrorBoundary>
    </div>
  );
}
