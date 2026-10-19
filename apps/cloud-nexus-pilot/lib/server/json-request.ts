export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

export function invalidJsonObjectResponse(): Response {
  return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
}
