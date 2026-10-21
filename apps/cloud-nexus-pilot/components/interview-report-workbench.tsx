"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { InterviewReport } from "@/lib/interview-intelligence/types";
import { createInterviewReportRepository, createReportOwnerTracker, readReportTranscriptOptions, type ReportTranscriptOption, type SavedInterviewReport } from "@/lib/interview-report-persistence";
import { supabase } from "@/lib/supabase";

export function InterviewReportWorkbench() {
  const repository = useMemo(() => createInterviewReportRepository(), []);
  const generation = useRef(0);
  const busy = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [transcriptText, setTranscriptText] = useState("");
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [error, setError] = useState("");
  const [localTranscripts, setLocalTranscripts] = useState<ReportTranscriptOption[]>([]);
  const [savedReports, setSavedReports] = useState<SavedInterviewReport[]>([]);
  const [saveNote, setSaveNote] = useState("");
  const [pendingSave, setPendingSave] = useState<{ report: InterviewReport; ownerId: string | null } | null>(null);
  const ownerTracker = useMemo(() => createReportOwnerTracker(() => {
    generation.current += 1;
    request.current?.abort();
    busy.current = false;
    setReport(null);
    setTranscriptText("");
    setLocalTranscripts([]);
    setSavedReports([]);
    setPendingSave(null);
    setSaveNote("");
    setError("");
    setStatus("idle");
  }), []);

  useEffect(() => {
    let active = true;
    let loadVersion = 0;
    async function loadReports() {
      const version = ++loadVersion;
      try {
        const result = await repository.list();
        if (active && version === loadVersion) {
          ownerTracker.observe(result.ownerId);
          setSavedReports(result.reports);
          setLocalTranscripts(readReportTranscriptOptions(result.ownerId));
        }
      } catch (caught) {
        if (active && version === loadVersion) setError(caught instanceof Error ? caught.message : "Saved reports could not be loaded.");
      }
    }
    void loadReports();
    const subscription = supabase?.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "INITIAL_SESSION") return;
      ownerTracker.observe(session?.user.id ?? null);
      void Promise.resolve().then(loadReports);
    }).data.subscription;
    return () => {
      active = false;
      generation.current += 1;
      request.current?.abort();
      subscription?.unsubscribe();
    };
  }, [repository, ownerTracker]);

  async function persistReport(value: InterviewReport, ownerId: string | null, version: number) {
    if (version !== generation.current) return;
    setPendingSave({ report: value, ownerId });
    const saved = await repository.save(value, ownerId);
    if (version !== generation.current) return;
    setReport(saved.report);
    setPendingSave(null);
    setSaveNote(saved.source === "remote" ? "Saved to your account." : "Saved on this browser only.");
    const result = await repository.list();
    if (version === generation.current) setSavedReports(result.reports);
  }

  async function retrySave() {
    if (!pendingSave || busy.current) return;
    busy.current = true;
    const version = ++generation.current;
    setStatus("loading");
    setError("");
    try {
      await persistReport(pendingSave.report, pendingSave.ownerId, version);
      if (version === generation.current) setStatus("ready");
    } catch (caught) {
      if (version === generation.current) {
        setStatus("failed");
        setError(caught instanceof Error ? caught.message : "Report save was not confirmed.");
      }
    } finally {
      if (version === generation.current) busy.current = false;
    }
  }

  async function generateReport() {
    if (busy.current) return;
    if (!transcriptText.trim()) {
      setStatus("failed");
      setError("Paste a transcript or load a saved local transcript first.");
      return;
    }

    busy.current = true;
    const version = ++generation.current;
    request.current = new AbortController();
    setStatus("loading");
    setError("");
    setReport(null);
    setPendingSave(null);
    setSaveNote("");

    try {
      const ownerId = await repository.getOwnerId();
      ownerTracker.observe(ownerId);
      if (version !== generation.current) return;
      const response = await fetch("/api/interview-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptText,
          sessionId: "local-summary-session",
        }),
        signal: request.current.signal,
      });
      if (!response.ok) throw new Error("Report generation failed.");
      const payload = (await response.json()) as { report?: InterviewReport };
      if (!payload.report) throw new Error("Report response was empty.");
      if (await repository.getOwnerId() !== ownerId) throw new Error("Your account changed. Generate the report again before saving.");
      if (version !== generation.current) return;
      setReport(payload.report);
      await persistReport(payload.report, ownerId, version);
      if (version === generation.current) setStatus("ready");
    } catch (caught) {
      if (version === generation.current) {
        setStatus("failed");
        setError(caught instanceof Error ? caught.message : "Report generation or save failed.");
      }
    } finally {
      if (version === generation.current) busy.current = false;
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

          {savedReports.length > 0 ? (
            <label className="mt-5 block text-sm font-medium text-slate-700">
              Saved reports
              <select
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm"
                value={report && savedReports.some((saved) => saved.report.id === report.id) ? report.id : ""}
                disabled={status === "loading"}
                onChange={(event) => {
                  const selected = savedReports.find((saved) => saved.report.id === event.target.value);
                  if (!selected) return;
                  setReport(selected.report);
                  setTranscriptText("");
                  setPendingSave(null);
                  setError("");
                  setStatus("ready");
                  setSaveNote(selected.source === "remote" ? "Loaded from your account." : "Loaded from this browser only.");
                }}
              >
                <option value="" disabled>Choose a saved report</option>
                {savedReports.map((saved) => <option key={saved.report.id} value={saved.report.id}>{new Date(saved.report.generatedAt).toLocaleString()}</option>)}
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
          {saveNote ? <p className="mt-3 text-sm text-slate-600">{saveNote}</p> : null}
          {pendingSave ? (
            <div className="mt-3 text-sm text-amber-800">
              <p>Report generated; saving has not been confirmed. Keep this page open to retry.</p>
              <button type="button" className="mt-2 underline" disabled={status === "loading"} onClick={() => void retrySave()}>Retry saving this report</button>
            </div>
          ) : null}
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
