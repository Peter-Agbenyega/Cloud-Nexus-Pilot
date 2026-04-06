import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SEGMENTS = 3;
const MAX_TOTAL_CHARS = 1_800;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_HAIKU_MODEL?.trim() || "claude-3-5-haiku-latest";

function buildExcerpt(segments: string[]): string {
  const normalized = segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(-MAX_SEGMENTS);

  let totalChars = 0;
  const capped: string[] = [];

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const segment = normalized[index];
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) break;
    const nextSegment =
      segment.length > remaining ? segment.slice(segment.length - remaining) : segment;
    capped.unshift(nextSegment);
    totalChars += nextSegment.length;
  }

  return capped.map((segment, index) => `Segment ${index + 1}: ${segment}`).join("\n");
}

function extractQuestionText(payload: unknown): string | null {
  const text =
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    Array.isArray((payload as { content?: unknown[] }).content)
      ? (payload as { content: Array<{ type?: string; text?: string }> }).content
          .filter((item) => item?.type === "text" && typeof item.text === "string")
          .map((item) => item.text?.trim() || "")
          .filter(Boolean)
          .join("\n")
      : "";

  if (!text || text.toLowerCase() === "null") {
    return null;
  }

  const normalized = text.split(/\r?\n/)[0]?.trim() || "";
  return normalized && normalized.toLowerCase() !== "null" ? normalized : null;
}

export async function POST(request: Request) {
  try {
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || "";
    if (!anthropicApiKey) {
      return NextResponse.json({ question: null }, { status: 200 });
    }

    const body = (await request.json().catch(() => ({}))) as { segments?: unknown };
    const segments = Array.isArray(body.segments)
      ? body.segments.filter((segment): segment is string => typeof segment === "string")
      : [];
    const excerpt = buildExcerpt(segments);

    if (!excerpt) {
      return NextResponse.json({ question: null }, { status: 200 });
    }

    const anthropicResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 64,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `You are a live conversation analyst. Given the transcript excerpt below, extract the single most recent question being asked.

Rules:
- Return ONLY the question text, cleaned and complete. Nothing else.
- If there is no clear question, return exactly: null
- Correct minor transcription errors
- Do not invent questions that are not present
- Behavioral prompts count as questions
- Maximum 1 sentence

Transcript excerpt:
${excerpt}`,
          },
        ],
      }),
      cache: "no-store",
    });

    if (!anthropicResponse.ok) {
      return NextResponse.json({ question: null }, { status: 200 });
    }

    const payload = (await anthropicResponse.json().catch(() => null)) as unknown;
    return NextResponse.json({ question: extractQuestionText(payload) }, { status: 200 });
  } catch {
    return NextResponse.json({ question: null }, { status: 200 });
  }
}
