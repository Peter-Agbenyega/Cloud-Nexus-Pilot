import { openAiEndpoint } from "@/lib/server/provider-endpoint";
import { createHash } from "node:crypto";
import { readJsonObject, invalidJsonObjectResponse } from "@/lib/server/json-request";
import { processingRepository } from "@/lib/server/processing-repository";
import { processingScope, readBoundedBytes } from "@/lib/server/request-boundary";
import { requireProviderUser } from "@/lib/server/provider-auth";
import { NextResponse } from "next/server";
import { createQuestionDedupeKey, detectStreamingQuestions } from "@/lib/interview-intelligence/question-detector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export async function POST(request: Request) {
  try {
    const body = await readJsonObject(request);
    if (!body) return invalidJsonObjectResponse();
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
    const firstDetectedQuestion = detectedQuestions.at(-1) ?? null;

    if (!firstDetectedQuestion) {
      return NextResponse.json({ question: null, detectedQuestion: null, questions: [] }, { status: 200 });
    }

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
    const auth = openAiApiKey ? await requireProviderUser(request) : null;
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

    const scope = processingScope(request.signal, 8_000);
    const requestHash = createHash("sha256").update(firstDetectedQuestion.normalizedQuestion).digest("hex");
    const operationId = `question:${requestHash}`;
    let acquired = false;
    let completed = false;
    try {
      if (!auth || auth.response) throw new Error("Authorization unavailable");
      const held = await processingRepository.reserve(auth, { operationId, requestHash, maxUnits: 1000, kind: "guidance" }, scope.signal);
      if (!held.acquired) throw new Error("Operation unavailable");
      acquired = true;
      const openAiResponse = await fetch(openAiEndpoint("chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
          temperature: 0,
          max_completion_tokens: 160,
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
        signal: scope.signal,
      });

      if (!openAiResponse.ok) {
        // Fall back to the extracted question, never the entire transcript window.
        throw new Error("Question normalization unavailable");
      }

      const reply = await readBoundedBytes(new Request("http://localhost/provider-result", { method: "POST", body: openAiResponse.body, signal: scope.signal, duplex: "half" } as RequestInit), 16_384);
      const data = JSON.parse(new TextDecoder().decode(reply)) as { choices?: Array<{ message?: { content?: string | null } }> };

      const cleanedQuestion = data?.choices?.[0]?.message?.content?.trim().slice(0, 500);
      const normalizedQuestion = cleanedQuestion || firstDetectedQuestion.normalizedQuestion;
      await processingRepository.complete(auth, { operationId, requestHash, usedUnits: 1000, outcome: "succeeded", result: { question: normalizedQuestion } });
      completed = true;
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
    } finally {
      scope.abort(); scope.dispose();
      if (acquired && !completed && auth && !auth.response) {
        await processingRepository.complete(auth, { operationId, requestHash, usedUnits: 1000, outcome: "unknown", result: { error: { code: "question_processing_incomplete" } } }).catch(() => {});
      }
    }
  } catch {
    return NextResponse.json({ question: null, detectedQuestion: null, questions: [] }, { status: 200 });
  }
}
