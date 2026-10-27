import { requireProviderUser } from "@/lib/server/provider-auth";
import { processingRepository } from "@/lib/server/processing-repository";
import { boundaryResponse, processingScope, RequestBoundaryError } from "@/lib/server/request-boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  const { sessionId } = await context.params;
  let cursor = Number(request.headers.get("last-event-id") || new URL(request.url).searchParams.get("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return boundaryResponse(new RequestBoundaryError(400, "invalid_cursor", "Invalid resume cursor."));
  try { await processingRepository.read(auth, sessionId, cursor, request.signal); } catch (error) { return boundaryResponse(error); }
  const scope = processingScope(request.signal, 50_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true; clearTimeout(timer); scope.dispose();
        try { controller.close(); } catch { /* consumer already cancelled */ }
      };
      const send = (payload: unknown, id?: number) => {
        if (!closed) controller.enqueue(encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(payload)}\n\n`));
      };
      scope.signal.addEventListener("abort", close, { once: true });
      send({ type: "status", sessionId, status: "connected" });
      const poll = async () => {
        try {
          // Reverify cookies/principal on every poll. Token refresh may not switch
          // identity under an existing subscription.
          const refreshed = await requireProviderUser(request);
          if (refreshed.response || refreshed.userId !== auth.userId) { close(); return; }
          const snapshot = await processingRepository.read(refreshed, sessionId, cursor, scope.signal);
          for (const event of snapshot.events) {
            if (event.sequence <= cursor) continue;
            const response = event.provider_result as { chunkIndex?: number } | null;
            if (response) send({ type: "chunk-result", sessionId, chunkIndex: response.chunkIndex, response }, event.sequence);
            cursor = event.sequence;
          }
          if (snapshot.status !== "active") { send({ type: "status", sessionId, status: "stopped" }); close(); return; }
          send({ type: "heartbeat", sessionId });
          if (!closed) timer = setTimeout(() => void poll(), 750);
        } catch { close(); }
      };
      void poll();
    },
    cancel() { closed = true; clearTimeout(timer); scope.abort(); scope.dispose(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "private, no-store, no-transform", connection: "keep-alive" } });
}
