import { NextResponse } from "next/server";

import { stopStreamingSession } from "@/lib/transcription/streaming-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const stopped = stopStreamingSession(sessionId);

  if (!stopped) {
    console.warn("[transcription][stream-session] stop-missing", { sessionId });
    return NextResponse.json(
      {
        error: {
          code: "transcript_stream_session_missing",
          message: "Streaming transcription session was not found.",
        },
      },
      { status: 404 }
    );
  }

  console.info("[transcription][stream-session] stop-success", { sessionId });

  return NextResponse.json({ sessionId, status: "stopped" }, { status: 200 });
}
