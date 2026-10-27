import { requireProviderUser } from "@/lib/server/provider-auth";
import { processingRepository } from "@/lib/server/processing-repository";
import { assertSameOrigin, boundaryResponse, readBoundedBytes } from "@/lib/server/request-boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    assertSameOrigin(request);
    await readBoundedBytes(request, 1024);
    const session = await processingRepository.create(auth, request.signal);
    return Response.json({ sessionId: session.sessionId, status: "created", createdAt: session.createdAt, saved: true }, { status: 201 });
  } catch (error) { return boundaryResponse(error); }
}
export async function DELETE(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    assertSameOrigin(request);
    const id = new URL(request.url).searchParams.get("sessionId");
    if (!id) return Response.json({ error: { code: "session_id_required", message: "A session ID is required." } }, { status: 400 });
    await processingRepository.stop(auth, id, request.signal);
    return Response.json({ sessionId: id, status: "stopped" });
  } catch (error) { return boundaryResponse(error); }
}

export async function GET(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    return Response.json({ sessions: await processingRepository.list(auth, request.signal), limit: 100 }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return boundaryResponse(error); }
}
