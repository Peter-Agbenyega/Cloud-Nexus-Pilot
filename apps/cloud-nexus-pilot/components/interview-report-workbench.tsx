"use client";

import { useEffect, useState } from "react";

import type { InterviewReport } from "@/lib/interview-intelligence/types";

type StoredTranscript = {
  id: string;
  title: string;
  transcriptText: string;
  updatedAt?: number;
};

function readLocalTranscripts(): StoredTranscript[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem("cloudnexus.transcripts.v1") ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is StoredTranscript => {
        const candidate = item as Partial<StoredTranscript>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.title === "string" &&
          typeof candidate.transcriptText === "string"
        );
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } catch {
    return [];
  }
}

export function InterviewReportWorkbench() {
  const [transcriptText, setTranscriptText] = useState("");
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [error, setError] = useState("");
  const [localTranscripts, setLocalTranscripts] = useState<StoredTranscript[]>([]);

  useEffect(() => {
    setLocalTranscripts(readLocalTranscripts());
  }, []);

  async function generateReport() {
    if (!transcriptText.trim()) {
      setStatus("failed");
      setError("Paste a transcript or load a saved local transcript first.");
      return;
    }

    setStatus("loading");
    setError("");
    setReport(null);

    try {
      const response = await fetch("/api/interview-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptText,
          sessionId: "local-summary-session",
        }),
      });
      if (!response.ok) throw new Error("Report generation failed.");
      const payload = (await response.json()) as { report?: InterviewReport };
      if (!payload.report) throw new Error("Report response was empty.");
      setReport(payload.report);
      setStatus("ready");
    } catch (caught) {
      setStatus("failed");
      setError(caught instanceof Error ? caught.message : "Report generation failed.");
    }
  }

  return (
    <section className="section-shell pb-16">
      <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="panel p-6">
          <h2 className="text-xl font-semibold text-slate-950">Interview Debrief</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Generate a rule-based report from a saved or pasted transcript. The text is sent to this app’s server for analysis; no AI provider is used. Scores are practice indicators, not an assessment of hiring outcomes.
          </p>

          {localTranscripts.length > 0 ? (
            <label className="mt-5 block text-sm font-medium text-slate-700">
              Saved transcript
              <select
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm"
                onChange={(event) => {
                  const selected = localTranscripts.find((item) => item.id === event.target.value);
                  if (selected) setTranscriptText(selected.transcriptText);
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  Choose a transcript
                </option>
                {localTranscripts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="mt-5 block text-sm font-medium text-slate-700">
            Transcript text
            <textarea
              className="mt-2 min-h-72 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-800"
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
              placeholder="Paste the final interview transcript here..."
            />
          </label>

          <button
            type="button"
            onClick={() => void generateReport()}
            disabled={status === "loading"}
            className="mt-4 rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {status === "loading" ? "Generating..." : "Generate Report"}
          </button>

          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
        </div>

        <div className="panel p-6">
          <h2 className="text-xl font-semibold text-slate-950">Report</h2>
          {!report ? (
            <p className="mt-4 text-sm leading-7 text-slate-600">
              The report will include question breakdown, strengths, weak signals, missed concepts,
              likely follow-ups, and study recommendations.
            </p>
          ) : (
            <div className="mt-5 space-y-5 text-sm text-slate-700">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">Questions</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{report.questions.length}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">Score</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{report.overallScore ?? "--"}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-xs uppercase text-slate-500">Study Items</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{report.studyRecommendations.length}</p>
                </div>
              </div>

              {[
                ["Strong answers", report.strongAnswers],
                ["Weak answers", report.weakAnswers],
                ["Missed technical concepts", report.missedTechnicalConcepts],
                ["Recommended better answers", report.recommendedBetterAnswers],
                ["Likely follow-up questions", report.likelyFollowUpQuestions],
                ["Study recommendations", report.studyRecommendations],
              ].map(([title, items]) => (
                <div key={title as string}>
                  <h3 className="font-semibold text-slate-950">{title as string}</h3>
                  {(items as string[]).length > 0 ? (
                    <ul className="mt-2 space-y-2">
                      {(items as string[]).map((item) => (
                        <li key={item} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-slate-500">No major items detected.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
