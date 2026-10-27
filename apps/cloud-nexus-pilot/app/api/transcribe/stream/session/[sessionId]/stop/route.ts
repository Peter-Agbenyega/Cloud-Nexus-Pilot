import { requireProviderUser } from "@/lib/server/provider-auth";
import { processingRepository } from "@/lib/server/processing-repository";
import { assertSameOrigin, boundaryResponse } from "@/lib/server/request-boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  try {
    assertSameOrigin(request);
    const { sessionId } = await context.params;
    await processingRepository.stop(auth, sessionId, request.signal);
    return Response.json({ sessionId, status: "stopped", saved: true });
  } catch (error) { return boundaryResponse(error); }
}
