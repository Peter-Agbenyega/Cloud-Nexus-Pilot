import { NextResponse } from "next/server";

import { buildInterviewContext } from "@/lib/interview-intelligence/context";
import { detectStreamingQuestions } from "@/lib/interview-intelligence/question-detector";
import { extractJobProfile, extractResumeProfile } from "@/lib/interview-intelligence/profile-ingestion";
import { createScreenContextFromText } from "@/lib/interview-intelligence/screen-context";
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

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const questionText = text(body.question, 600);
  const detectedQuestion = detectStreamingQuestions({ text: questionText })[0];

  if (!detectedQuestion) {
    return NextResponse.json(
      {
        error: "question_required",
        message: "A question or interview prompt is required to build context.",
      },
      { status: 400 }
    );
  }

  const resumeProfile = extractResumeProfile(text(body.resumeText, 20_000));
  const jobProfile = extractJobProfile(text(body.jobDescriptionText, 20_000), resumeProfile);
  const screenText = text(body.screenText, 5_000);

  return NextResponse.json({
    question: detectedQuestion,
    resumeProfile,
    jobProfile,
    context: buildInterviewContext({
      question: detectedQuestion,
      recentTranscript: text(body.transcriptContext, 2_000),
      mode: mode(body.interviewMode),
      resumeProfile,
      jobProfile,
      companyContext: text(body.companyContext, 1_000),
      screenContext: screenText ? createScreenContextFromText(screenText) : null,
    }),
  });
}
