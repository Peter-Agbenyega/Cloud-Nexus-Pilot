"use client";

import { useState } from "react";

import type { InterviewMode, InterviewReport } from "@/lib/interview-intelligence/types";
import type {
  MockInterviewDifficulty,
  MockInterviewTurn,
} from "@/lib/interview-intelligence/mock-interview";

const MODE_OPTIONS: InterviewMode[] = [
  "behavioral",
  "cloud-engineering",
  "aws",
  "devops",
  "devsecops",
  "cybersecurity",
  "kubernetes",
  "terraform-iac",
  "system-design",
  "coding",
  "terminal-debugging",
];

const DIFFICULTY_OPTIONS: MockInterviewDifficulty[] = ["mid", "senior", "principal", "entry"];

function createTurn(role: MockInterviewTurn["role"], text: string): MockInterviewTurn {
  return {
    id: `mock-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  };
}

export function MockInterviewWorkbench() {
  const [role, setRole] = useState("Senior Platform Engineer");
  const [difficulty, setDifficulty] = useState<MockInterviewDifficulty>("senior");
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("devops");
  const [resumeText, setResumeText] = useState("");
  const [jobDescriptionText, setJobDescriptionText] = useState("");
  const [companyContext, setCompanyContext] = useState("");
  const [history, setHistory] = useState<MockInterviewTurn[]>([]);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [feedback, setFeedback] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [contextSummary, setContextSummary] = useState<string[]>([]);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");

  async function requestTurn(nextHistory: MockInterviewTurn[], finish = false) {
    setStatus("loading");
    setReport(null);
    try {
      const response = await fetch("/api/mock-interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resumeText,
          jobDescriptionText,
          role,
          companyContext,
          difficulty,
          interviewMode,
          history: nextHistory,
          finish,
        }),
      });
      if (!response.ok) throw new Error("Mock interview turn failed.");
      const payload = (await response.json()) as {
        nextQuestion: string | null;
        followUp: string | null;
        score: number | null;
        feedback: string | null;
        report: InterviewReport | null;
        contextSummary: string[];
      };
      setFeedback(payload.feedback ?? "");
      setScore(payload.score);
      setContextSummary(payload.contextSummary ?? []);
      if (payload.report) {
        setReport(payload.report);
        setStatus("ready");
        return;
      }
      const nextQuestion = payload.followUp || payload.nextQuestion;
      setHistory(nextQuestion ? [...nextHistory, createTurn("interviewer", nextQuestion)] : nextHistory);
      setStatus("ready");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Mock interview failed.");
      setStatus("failed");
    }
  }

  function handleStart() {
    setHistory([]);
    setDraftAnswer("");
    setFeedback("");
    setScore(null);
    setContextSummary([]);
    void requestTurn([]);
  }

  function handleSubmitAnswer() {
    const answer = draftAnswer.trim();
    if (!answer) return;
    const nextHistory = [...history, createTurn("candidate", answer)];
    setHistory(nextHistory);
    setDraftAnswer("");
    void requestTurn(nextHistory);
  }

  function handleFinish() {
    void requestTurn(history, true);
  }

  return (
    <div style={{ display: "grid", gap: 16, gridTemplateColumns: "320px minmax(0, 1fr)" }}>
      <section style={{ background: "#13131F", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "grid", gap: 10 }}>
          <input
            aria-label="Target role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, padding: "9px 10px" }}
          />
          <select
            aria-label="Interview mode"
            value={interviewMode}
            onChange={(event) => setInterviewMode(event.target.value as InterviewMode)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, padding: "9px 10px" }}
          >
            {MODE_OPTIONS.map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
          <select
            aria-label="Difficulty"
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value as MockInterviewDifficulty)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, padding: "9px 10px" }}
          >
            {DIFFICULTY_OPTIONS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <textarea
            aria-label="Resume text"
            placeholder="Resume evidence"
            value={resumeText}
            onChange={(event) => setResumeText(event.target.value)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, minHeight: 90, padding: 10, resize: "vertical" }}
          />
          <textarea
            aria-label="Job description"
            placeholder="Job description"
            value={jobDescriptionText}
            onChange={(event) => setJobDescriptionText(event.target.value)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, minHeight: 90, padding: 10, resize: "vertical" }}
          />
          <input
            aria-label="Company context"
            placeholder="Company context"
            value={companyContext}
            onChange={(event) => setCompanyContext(event.target.value)}
            style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 12, padding: "9px 10px" }}
          />
          <button
            type="button"
            onClick={handleStart}
            disabled={status === "loading"}
            style={{ background: "#4F46E5", border: 0, borderRadius: 8, color: "white", cursor: status === "loading" ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500, padding: "10px 12px" }}
          >
            {history.length ? "Restart Mock" : "Start Mock"}
          </button>
        </div>
      </section>

      <section style={{ background: "#13131F", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 12, minHeight: 560, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            <p style={{ color: "#E0E0FF", fontSize: 13, fontWeight: 600 }}>Mock Interview</p>
            <p style={{ color: "#7070A0", fontSize: 11 }}>{status === "loading" ? "Thinking..." : `${history.length} turns`}</p>
          </div>
          <button
            type="button"
            onClick={handleFinish}
            disabled={history.length === 0 || status === "loading"}
            style={{ background: "transparent", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#A0A0C0", cursor: history.length === 0 ? "not-allowed" : "pointer", fontSize: 12, padding: "7px 10px" }}
          >
            Finish
          </button>
        </div>

        <div style={{ display: "grid", gap: 10, marginBottom: 12, maxHeight: 300, overflowY: "auto" }}>
          {history.length === 0 ? (
            <p style={{ color: "#7070A0", fontSize: 13 }}>Start a mock interview to begin.</p>
          ) : (
            history.map((turn) => (
              <div
                key={turn.id}
                style={{
                  background: turn.role === "interviewer" ? "rgba(79,70,229,0.12)" : "#0D0D1A",
                  border: "0.5px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  color: "#DCDCFF",
                  fontSize: 13,
                  lineHeight: 1.55,
                  padding: 10,
                }}
              >
                <strong style={{ color: turn.role === "interviewer" ? "#9F9CFF" : "#2DD4BF", display: "block", fontSize: 11, marginBottom: 4 }}>
                  {turn.role === "interviewer" ? "Interviewer" : "Candidate"}
                </strong>
                {turn.text}
              </div>
            ))
          )}
        </div>

        {feedback && (
          <div style={{ background: "#0D0D1A", border: "0.5px solid rgba(45,212,191,0.18)", borderRadius: 8, color: "#A0A0C0", fontSize: 12, lineHeight: 1.5, marginBottom: 12, padding: 10 }}>
            {score !== null && <strong style={{ color: "#2DD4BF", marginRight: 8 }}>Score {score}/9</strong>}
            {feedback}
          </div>
        )}

        {contextSummary.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {contextSummary.map((item) => (
              <span key={item} style={{ border: "0.5px solid rgba(124,108,255,0.3)", borderRadius: 999, color: "#A0A0FF", fontSize: 10, padding: "4px 8px" }}>
                {item.slice(0, 80)}
              </span>
            ))}
          </div>
        )}

        {report ? (
          <div style={{ color: "#DCDCFF", display: "grid", gap: 8, fontSize: 13 }}>
            <p style={{ color: "#E0E0FF", fontWeight: 600 }}>Final Score: {report.overallScore ?? "Not enough transcript"}</p>
            {report.recommendedBetterAnswers.slice(0, 3).map((item) => (
              <p key={item} style={{ color: "#A0A0C0", lineHeight: 1.5 }}>{item}</p>
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <textarea
              aria-label="Candidate answer"
              placeholder="Type your answer"
              value={draftAnswer}
              onChange={(event) => setDraftAnswer(event.target.value)}
              style={{ background: "#0D0D1A", border: "0.5px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#DCDCFF", fontSize: 13, minHeight: 120, padding: 10, resize: "vertical" }}
            />
            <button
              type="button"
              onClick={handleSubmitAnswer}
              disabled={!draftAnswer.trim() || status === "loading" || history.length === 0}
              style={{ background: "#4F46E5", border: 0, borderRadius: 8, color: "white", cursor: !draftAnswer.trim() || status === "loading" || history.length === 0 ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500, padding: "10px 12px" }}
            >
              Submit Answer
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
