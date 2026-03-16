import { AppShell } from "@/components/app-shell";

const nav = [
  { label: "Overview", href: "/dashboard" },
  { label: "Transcripts", href: "/transcripts" },
  { label: "Prompt Library", href: "/prompt-library" },
  { label: "Pricing", href: "/pricing" },
];

export default function DashboardPage() {
  return (
    <AppShell
      title="Workspace Overview"
      description="A clean dashboard shell ready for metrics, workspace settings, billing, and recent activity."
      nav={nav}
    >
      <div className="grid gap-6 md:grid-cols-3">
        {[
          ["Uploads this week", "18"],
          ["Saved prompt sets", "12"],
          ["Pending summaries", "4"],
        ].map(([label, value]) => (
          <div key={label} className="panel p-6">
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-3 text-4xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <div className="panel p-8">
        <h2 className="text-2xl font-semibold text-slate-950">Recent activity</h2>
        <div className="mt-6 space-y-4">
          {[
            "Interview debrief prompt updated for growth roles",
            "Candidate call transcript uploaded and queued",
            "Weekly stakeholder summary template published",
          ].map((item) => (
            <div key={item} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
              {item}
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
