import { AppShell } from "@/components/app-shell";

const nav = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Upload Queue", href: "/transcripts" },
  { label: "AI Summary", href: "/summary" },
  { label: "Prompt Library", href: "/prompt-library" },
];

export default function TranscriptsPage() {
  return (
    <AppShell
      title="Transcript Uploads"
      description="Prepare the upload area for audio, transcript files, or meeting note imports."
      nav={nav}
    >
      <div className="panel p-8">
        <h2 className="text-2xl font-semibold text-slate-950">Upload transcript</h2>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          Replace this placeholder with your storage integration, validation flow, and processing queue.
        </p>
        <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-14 text-center text-sm text-slate-500">
          Drag transcripts here or connect a recorder pipeline.
        </div>
      </div>
      <div className="panel p-8">
        <h2 className="text-2xl font-semibold text-slate-950">Recent uploads</h2>
        <div className="mt-6 space-y-3">
          {[
            "Engineering manager interview - March panel",
            "Customer discovery call - enterprise prospect",
            "Weekly hiring sync - product and design",
          ].map((item) => (
            <div key={item} className="rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-700">
              {item}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
