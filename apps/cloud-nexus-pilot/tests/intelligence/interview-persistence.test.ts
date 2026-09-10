import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  createInterviewPersistenceRepository,
  INTERVIEW_SESSION_STORAGE_KEY,
} from "../../lib/interview-persistence";

type LocalStorageMock = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

function createLocalStorageMock(): LocalStorageMock {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createLocalStorageMock(),
    },
  });
});

test("interview persistence falls back to local session storage without Supabase credentials", async () => {
  const repository = createInterviewPersistenceRepository();

  const { data: session, persistence } = await repository.createSession({
    title: "Platform engineer screen",
    mode: "devops",
    resumeText: "Led Terraform automation and AWS IAM remediation.",
    jobDescriptionText: "Required: AWS, Terraform, Kubernetes, CI/CD.",
    companyContext: "Cloud platform team",
    notes: "Expect DevSecOps and incident response questions.",
  });

  assert.equal(session.source, "local");
  assert.equal(session.status, "active");
  assert.equal(session.mode, "devops");
  assert.equal(persistence.mode, "local");

  const rawStore = window.localStorage.getItem(INTERVIEW_SESSION_STORAGE_KEY);
  assert.ok(rawStore);
  assert.match(rawStore, /Platform engineer screen/);
});

test("local interview persistence stores transcript, question, guidance, and end state", async () => {
  const repository = createInterviewPersistenceRepository();
  const { data: session } = await repository.createSession({
    title: "Live interview",
    mode: "general",
    resumeText: "",
    jobDescriptionText: "",
    companyContext: "",
    notes: "",
  });

  const transcriptResult = await repository.saveTranscriptSegment({
    sessionId: session.id,
    clientEventId: "segment-1",
    source: "microphone",
    text: "Walk me through debugging a Terraform AccessDenied error.",
    isPartial: false,
    capturedAt: "2026-09-10T12:00:00.000Z",
  });
  const questionResult = await repository.saveDetectedQuestion({
    sessionId: session.id,
    questionId: "question-1",
    rawText: "Walk me through debugging a Terraform AccessDenied error.",
    normalizedQuestion: "Walk me through debugging a Terraform AccessDenied error.",
    category: "terminal_debugging",
    confidence: 0.88,
    urgency: "high",
    requiresCodeContext: true,
    detectedAt: "2026-09-10T12:00:01.000Z",
  });
  const guidanceResult = await repository.saveGuidance({
    sessionId: session.id,
    detectedQuestionId: questionResult.data,
    guidance: {
      headline: "Diagnose IAM first",
      speakNow: "I would confirm the failing principal, action, and resource before changing policy.",
      keyPoints: ["Check caller identity", "Read the denied action", "Apply least privilege"],
      example: null,
      technicalDetail: "Use aws sts get-caller-identity and inspect Terraform provider role.",
      caution: "Avoid broad AdministratorAccess as a shortcut.",
      followUp: null,
      provider: null,
      model: null,
      latencyMs: 950,
    },
  });
  const screenResult = await repository.saveScreenContext({
    sessionId: session.id,
    context: {
      timestamp: "2026-09-10T12:00:02.000Z",
      sourceType: "terminal",
      extractedText: "kubectl get pods returned Forbidden",
      detectedLanguage: "Shell",
      errorMessages: ["Forbidden"],
      codeSnippet: "kubectl get pods",
      infrastructureResources: [],
      diagramSummary: null,
      confidence: 0.78,
    },
  });
  const endResult = await repository.endSession(session.id);

  assert.equal(transcriptResult.data, "segment-1");
  assert.equal(questionResult.data, "question-1");
  assert.match(guidanceResult.data, /^guidance-/);
  assert.match(screenResult.data, /^screen-context-/);
  assert.equal(endResult.data?.status, "ended");

  const rawStore = window.localStorage.getItem(INTERVIEW_SESSION_STORAGE_KEY);
  assert.ok(rawStore);
  const store = JSON.parse(rawStore) as {
    transcriptSegments: unknown[];
    detectedQuestions: unknown[];
    guidanceItems: unknown[];
    screenContextEvents: unknown[];
  };
  assert.equal(store.transcriptSegments.length, 1);
  assert.equal(store.detectedQuestions.length, 1);
  assert.equal(store.guidanceItems.length, 1);
  assert.equal(store.screenContextEvents.length, 1);
});
