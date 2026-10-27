import { readBoundedJson } from "./request-boundary";

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try { return await readBoundedJson(request); } catch { return null; }
}

export function invalidJsonObjectResponse(): Response {
  return Response.json({ error: "Request body must be a bounded JSON object from this application." }, { status: 400 });
}
