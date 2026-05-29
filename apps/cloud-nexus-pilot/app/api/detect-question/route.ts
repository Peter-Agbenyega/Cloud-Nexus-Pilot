import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4.1-mini";
const QUESTION_KEYWORDS = ["what", "how", "why", "tell me", "any questions", "can you", "would you"];

function looksLikeQuestion(text: string) {
  const normalizedText = text.toLowerCase();
  return QUESTION_KEYWORDS.some((keyword) => normalizedText.includes(keyword));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { segments?: unknown };
    const segments = Array.isArray(body.segments)
      ? body.segments.filter((segment): segment is string => typeof segment === "string")
      : [];
    const fullText = segments.join(" ").trim();

    if (!fullText) {
      return NextResponse.json({ question: null }, { status: 200 });
    }

    if (!looksLikeQuestion(fullText)) {
      return NextResponse.json({ question: null }, { status: 200 });
    }

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
    if (!openAiApiKey) {
      return NextResponse.json({ question: fullText }, { status: 200 });
    }

    try {
      const openAiResponse = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "Fix the transcription into a clean, natural question. Return ONLY the corrected question.",
            },
            {
              role: "user",
              content: fullText,
            },
          ],
        }),
        cache: "no-store",
        signal: request.signal,
      });

      if (!openAiResponse.ok) {
        return NextResponse.json({ question: fullText }, { status: 200 });
      }

      const data = (await openAiResponse.json().catch(() => null)) as
        | {
            choices?: Array<{ message?: { content?: string | null } }>;
          }
        | null;

      const cleanedQuestion = data?.choices?.[0]?.message?.content?.trim();
      return NextResponse.json({ question: cleanedQuestion || fullText }, { status: 200 });
    } catch {
      return NextResponse.json({ question: fullText }, { status: 200 });
    }
  } catch {
    return NextResponse.json({ question: null }, { status: 200 });
  }
}
