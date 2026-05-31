import { TranscriptPanel } from "@/features/transcription/transcript-panel";

export default function TranscriptsPage() {
  return (
    <div className="section-shell py-10">
      <h1 style={{ fontSize: 20, fontWeight: 500, color: "#F0F0FF", marginBottom: 4 }}>
        Transcription Workspace
      </h1>
      <p style={{ fontSize: 13, color: "#6060A0", marginBottom: 24 }}>
        Capture live audio, stage uploads, and review transcript output
      </p>
      <TranscriptPanel />
    </div>
  );
}
