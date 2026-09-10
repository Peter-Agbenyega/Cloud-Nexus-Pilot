import { NextResponse } from "next/server";

import {
  runMockInterviewTurn,
  type MockInterviewDifficulty,
  type MockInterviewTurn,
} from "@/lib/interview-intelligence/mock-interview";
import type { InterviewMode } from "@/lib/interview-intelligence/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function mode(value: unknown): InterviewMode {
  const normalized = text(value, 80).toLowerCase().replace(/_/g, "-");
  const allowed: InterviewMode[] = [
    "general",
    "behavioral",
    "ksa",
    "leadership",
    "cloud-engineering",
    "aws",
    "azure",
    "devops",
    "devsecops",
    "cybersecurity",
    "kubernetes",
    "terraform-iac",
    "system-design",
    "coding",
    "terminal-debugging",
  ];
  return allowed.includes(normalized as InterviewMode) ? (normalized as InterviewMode) : "general";
}

function difficulty(value: unknown): MockInterviewDifficulty {
  return value === "entry" || value === "mid" || value === "senior" || value === "principal"
    ? value
    : "senior";
}

function history(value: unknown): MockInterviewTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((turn): turn is Record<string, unknown> => Boolean(turn) && typeof turn === "object")
    .slice(-16)
    .map((turn): MockInterviewTurn => {
      const role: MockInterviewTurn["role"] =
        turn.role === "candidate" ? "candidate" : "interviewer";
      return {
        id: text(turn.id, 120) || `turn-${Date.now()}`,
        role,
        text: text(turn.text, 2_000),
        createdAt: text(turn.createdAt, 80) || new Date().toISOString(),
        score: typeof turn.score === "number" ? turn.score : null,
        feedback: typeof turn.feedback === "string" ? turn.feedback : null,
      };
    })
    .filter((turn) => turn.text);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json(
    runMockInterviewTurn({
      resumeText: text(body.resumeText, 20_000),
      jobDescriptionText: text(body.jobDescriptionText, 20_000),
      role: text(body.role, 160),
      companyContext: text(body.companyContext, 1_200),
      difficulty: difficulty(body.difficulty),
      interviewMode: mode(body.interviewMode),
      history: history(body.history),
      finish: body.finish === true,
    })
  );
}
