import { NextResponse } from "next/server";

import { diagnoseTerminalArtifact } from "@/lib/interview-intelligence/terminal-debugging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const artifactText = text(body.text ?? body.artifactText ?? body.screenText, 8_000);

  if (!artifactText) {
    return NextResponse.json(
      {
        error: "artifact_text_required",
        message: "Terminal, log, command, or error text is required for diagnosis.",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    diagnosis: diagnoseTerminalArtifact(artifactText),
  });
}
