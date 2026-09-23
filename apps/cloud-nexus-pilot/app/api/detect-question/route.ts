import { requireProviderUser } from "@/lib/server/provider-auth";
import { NextResponse } from "next/server";
import { createQuestionDedupeKey, detectStreamingQuestions } from "@/lib/interview-intelligence/question-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4.1-mini";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      segments?: unknown;
      seenQuestionKeys?: unknown;
    };
    const segments = Array.isArray(body.segments)
      ? body.segments.filter((segment): segment is string => typeof segment === "string")
      : [];
    const seenQuestionKeys = Array.isArray(body.seenQuestionKeys)
      ? new Set(body.seenQuestionKeys.filter((item): item is string => typeof item === "string"))
      : undefined;
    const fullText = segments.join(" ").trim();

    if (!fullText) {
      return NextResponse.json({ question: null, detectedQuestion: null, questions: [] }, { status: 200 });
    }

    const detectedQuestions = detectStreamingQuestions({
      text: fullText,
      seenQuestionKeys,
    });
    const firstDetectedQuestion = detectedQuestions[0] ?? null;

    if (!firstDetectedQuestion) {
      return NextResponse.json({ question: null, detectedQuestion: null, questions: [] }, { status: 200 });
    }

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
    const auth = openAiApiKey ? await requireProviderUser() : null;
    // Keep deterministic question detection available without provider authorization.
    if (!openAiApiKey || auth?.response) {
      return NextResponse.json(
        {
          question: firstDetectedQuestion.normalizedQuestion,
          questionKey: createQuestionDedupeKey(firstDetectedQuestion.normalizedQuestion),
          detectedQuestion: firstDetectedQuestion,
          questions: detectedQuestions,
        },
        { status: 200 }
      );
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
              content: firstDetectedQuestion.normalizedQuestion,
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
      const normalizedQuestion = cleanedQuestion || firstDetectedQuestion.normalizedQuestion;
      return NextResponse.json(
        {
          question: normalizedQuestion,
          questionKey: createQuestionDedupeKey(normalizedQuestion),
          detectedQuestion: {
            ...firstDetectedQuestion,
            normalizedQuestion,
          },
          questions: detectedQuestions,
        },
        { status: 200 }
      );
    } catch {
      return NextResponse.json(
        {
          question: firstDetectedQuestion.normalizedQuestion,
          questionKey: createQuestionDedupeKey(firstDetectedQuestion.normalizedQuestion),
          detectedQuestion: firstDetectedQuestion,
          questions: detectedQuestions,
        },
        { status: 200 }
      );
    }
  } catch {
    return NextResponse.json({ question: null, detectedQuestion: null, questions: [] }, { status: 200 });
  }
}
