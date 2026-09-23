import { requireProviderUser } from "@/lib/server/provider-auth";
import { getStreamingSession, subscribeToStreamingSession } from "@/lib/transcription/streaming-session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const auth = await requireProviderUser();
  if (auth.response) return auth.response;
  const { sessionId } = await context.params;
  const session = getStreamingSession(sessionId, auth.userId);

  if (!session || session.stopped) {
    console.warn("[transcription][stream-session] events-missing", { sessionId });
    return new Response(
      JSON.stringify({
        error: {
          code: "transcript_stream_session_missing",
          message: "Streaming transcription session was not found.",
        },
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }

  console.info("[transcription][stream-session] events-connected", { sessionId });

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          toSseChunk({
            type: "status",
            sessionId,
            status: "connected",
          })
        )
      );

      unsubscribe = subscribeToStreamingSession(sessionId, auth.userId, (event) => {
        console.info("[transcription][stream-session] events-push", {
          sessionId,
          type: event.type,
          chunkIndex: "chunkIndex" in event ? event.chunkIndex : undefined,
        });
        controller.enqueue(encoder.encode(toSseChunk(event)));
      });

      if (!unsubscribe) {
        controller.enqueue(
          encoder.encode(
            toSseChunk({
              type: "chunk-error",
              sessionId,
              chunkIndex: -1,
              error: {
                code: "transcript_stream_session_missing",
                message: "Streaming transcription session became unavailable.",
              },
            })
          )
        );
        controller.close();
        return;
      }

      heartbeat = setInterval(() => {
        controller.enqueue(
          encoder.encode(
            `event: heartbeat\ndata: ${JSON.stringify({
              type: "heartbeat",
              sessionId,
              at: Date.now(),
            })}\n\n`
          )
        );
      }, 15_000);
    },
    cancel() {
      console.info("[transcription][stream-session] events-disconnected", { sessionId });
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
