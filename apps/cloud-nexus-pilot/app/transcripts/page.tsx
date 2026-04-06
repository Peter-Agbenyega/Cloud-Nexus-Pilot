import { AppShell } from "@/components/app-shell";
import { TranscriptPanel } from "@/features/transcription/transcript-panel";

const nav = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Upload Queue", href: "/transcripts" },
  { label: "AI Summary", href: "/summary" },
  { label: "Prompt Library", href: "/prompt-library" },
];

export default function TranscriptsPage() {
  return (
    <AppShell
      title="Transcription Workspace"
      description="Capture live audio, stage uploads, and review transcript output in a frontend-safe workflow that is ready for future backend wiring."
      nav={nav}
    >
      <TranscriptPanel />
    </AppShell>
  );
}
