import { requireProviderUser } from "@/lib/server/provider-auth";
import { processingRepository } from "@/lib/server/processing-repository";
import { assertSameOrigin, boundaryResponse, RequestBoundaryError } from "@/lib/server/request-boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };
export async function GET(request: Request, context: Context) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    const { sessionId } = await context.params;
    const cursor = Number(new URL(request.url).searchParams.get("cursor") || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RequestBoundaryError(400, "invalid_cursor", "Invalid resume cursor.");
    const saved = await processingRepository.read(auth, sessionId, cursor, request.signal);
    if (new URL(request.url).searchParams.get("format") === "export" && saved.hasMore) {
      throw new RequestBoundaryError(413, "export_page_limit", "This export exceeds one bounded page. Retrieve saved pages using nextCursor before exporting all results.");
    }
    const headers: Record<string, string> = { "cache-control": "private, no-store" };
    if (new URL(request.url).searchParams.get("format") === "export") headers["content-disposition"] = 'attachment; filename="pilot-session.json"';
    return Response.json({ ...saved, saved: true, audioRetained: false, captureGap: "Live audio during interruption is not recoverable. Saved final events are retained." }, { headers });
  } catch (error) { return boundaryResponse(error); }
}
export async function DELETE(request: Request, context: Context) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    assertSameOrigin(request);
    const { sessionId } = await context.params;
    await processingRepository.delete(auth, sessionId, request.signal);
    return Response.json({ sessionId, deleted: true });
  } catch (error) { return boundaryResponse(error); }
}
