export type AnswerMode = "general" | "concise" | "detailed" | "technical" | "star";

export type InterviewIntent =
  | "general"
  | "behavioral"
  | "technical"
  | "system_design"
  | "comparison"
  | "follow_up";

export type SessionMemoryTurn = {
  prompt: string;
  answer: string;
  role: string;
  answerMode: AnswerMode;
};

export type SessionMemoryContext = {
  resumeSummary: string;
  jobSummary: string;
};

export type InterviewRequest = {
  prompt: string;
  question?: string;
  role?: string;
  answerMode?: AnswerMode;
  sessionId?: string | null;
  resumeText?: string | null;
  jobDescriptionText?: string | null;
  interviewIntent?: InterviewIntent | null;
};

export type InterviewResponseMetadata = {
  intent: InterviewIntent;
  sessionMemoryUsed: boolean;
  resumeContextUsed: boolean;
  jobContextUsed: boolean;
};

export type InterviewResponse = {
  answer: string;
  sessionId?: string | null;
  answerMode: AnswerMode;
  metadata?: InterviewResponseMetadata;
  suggestedFollowups?: string[];
};

export type InterviewStreamStartEvent = {
  event: "start";
  data: {
    sessionId?: string | null;
    answerMode: AnswerMode;
    done: false;
  };
};

export type InterviewStreamMetaEvent = {
  event: "meta";
  data: {
    sessionId?: string | null;
    answerMode: AnswerMode;
    metadata: InterviewResponseMetadata;
    suggestedFollowups: string[];
    done: false;
  };
};

export type InterviewStreamTokenEvent = {
  event: "token";
  data: {
    token: string;
    done: false;
  };
};

export type InterviewStreamFinalEvent = {
  event: "final";
  data: {
    answer: string;
    sessionId?: string | null;
    answerMode: AnswerMode;
    done: false;
  };
};

export type InterviewStreamErrorEvent = {
  event: "error";
  data: {
    error: string;
    message: string;
    done: false;
  };
};

export type InterviewStreamDoneEvent = {
  event: "done";
  data: {
    done: true;
  };
};

export type InterviewStreamEvent =
  | InterviewStreamStartEvent
  | InterviewStreamMetaEvent
  | InterviewStreamTokenEvent
  | InterviewStreamFinalEvent
  | InterviewStreamErrorEvent
  | InterviewStreamDoneEvent;

export const INTERVIEW_ENDPOINTS = {
  answer: "/interview",
  stream: "/interview/stream",
} as const;

export function createInterviewRequestPayload(
  input: InterviewRequest
): Record<string, string | null | undefined> {
  return {
    prompt: input.prompt,
    question: input.question,
    role: input.role?.trim() || "DevOps Engineer",
    answer_mode: input.answerMode ?? "general",
    session_id: input.sessionId?.trim() || null,
    resume_text: input.resumeText?.trim() || null,
    job_description_text: input.jobDescriptionText?.trim() || null,
    interview_intent: input.interviewIntent ?? null,
  };
}
