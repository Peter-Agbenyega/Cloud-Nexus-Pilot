import { requireProviderUser } from "@/lib/server/provider-auth";
import { NextResponse } from "next/server";

import {
  createStreamingSession,
  stopStreamingSession,
} from "@/lib/transcription/streaming-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireProviderUser();
  if (auth.response) return auth.response;
  const session = createStreamingSession(auth.userId);
  console.info("[transcription][stream-session] created", {
    sessionId: session.id,
    createdAt: session.createdAt,
  });

  return NextResponse.json(
    {
      sessionId: session.id,
      status: "created",
      createdAt: session.createdAt,
      note:
        "Streaming session created. Use chunk ingest + event stream routes for continuity-safe transcript transport.",
    },
    { status: 201 }
  );
}

export async function DELETE(request: Request) {
  const auth = await requireProviderUser();
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return NextResponse.json(
      {
        error: {
          code: "transcript_stream_session_id_required",
          message: "sessionId is required to stop a streaming transcription session.",
        },
      },
      { status: 400 }
    );
  }

  const stopped = stopStreamingSession(sessionId, auth.userId);
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

  console.info("[transcription][stream-session] stopped", { sessionId });

  return NextResponse.json({ sessionId, status: "stopped" }, { status: 200 });
}
