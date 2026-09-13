import { NextResponse } from "next/server";

import { generateInterviewReport } from "@/lib/interview-intelligence/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const transcriptText = text(body.transcriptText, 60_000);

  if (!transcriptText) {
    return NextResponse.json(
      {
        error: "transcript_required",
        message: "Transcript text is required to generate an interview report.",
      },
      { status: 400 }
    );
  }

  const knownAnswers = Array.isArray(body.knownAnswers)
    ? body.knownAnswers.filter((item): item is string => typeof item === "string")
    : [];

  return NextResponse.json({
    report: generateInterviewReport({
      sessionId: text(body.sessionId, 120) || "local-session",
      transcriptText,
      knownAnswers,
    }),
  });
}
