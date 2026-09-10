import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInterviewContext } from "../../lib/interview-intelligence/context";
import { createQuestionDedupeKey, detectStreamingQuestions } from "../../lib/interview-intelligence/question-detector";
import { extractJobProfile, extractResumeProfile } from "../../lib/interview-intelligence/profile-ingestion";
import { generateInterviewReport } from "../../lib/interview-intelligence/report";
import { createScreenContextFromText } from "../../lib/interview-intelligence/screen-context";

test("detects implicit technical prompts and classifies cloud debugging context", () => {
  const questions = detectStreamingQuestions({
    text: "Walk me through how you would debug this Terraform AccessDenied error in AWS.",
    timestamp: new Date("2026-09-10T12:00:00.000Z"),
  });

  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.category, "terminal_debugging");
  assert.equal(questions[0]?.requiresCodeContext, true);
  assert.equal(questions[0]?.requiresVisualContext, true);
  assert.ok((questions[0]?.confidence ?? 0) >= 0.8);
});

test("suppresses previously seen questions by normalized dedupe key", () => {
  const seen = new Set([
    createQuestionDedupeKey("How would you design a highly available Kubernetes platform?"),
  ]);

  const questions = detectStreamingQuestions({
    text: "How would you design a highly available Kubernetes platform?",
    seenQuestionKeys: seen,
  });

  assert.equal(questions.length, 0);
});

test("extracts resume and job profiles, then packs only relevant evidence", () => {
  const resume = extractResumeProfile(`
    Senior DevOps Engineer
    Automated Terraform modules and reduced deployment failures by 40%.
    Led incident response and IAM least privilege remediation.
    AWS Certified Solutions Architect.
  `);
  const job = extractJobProfile(`
    Required: AWS, Terraform, Kubernetes, CI/CD, IAM.
    Responsibilities include designing secure cloud platforms and improving observability.
    Preferred: DevSecOps and OWASP experience.
  `, resume);
  const question = detectStreamingQuestions({
    text: "Tell me about a time you improved Terraform deployment reliability.",
  })[0];

  assert.ok(question);
  const context = buildInterviewContext({
    question,
    recentTranscript: "The interviewer is asking about infrastructure reliability.",
    mode: "devops",
    resumeProfile: resume,
    jobProfile: job,
  });

  assert.ok(resume.certifications.some((item) => /AWS Certified/i.test(item)));
  assert.ok(job.keywords.includes("terraform"));
  assert.ok(context.resumeEvidence.some((item) => /Terraform/i.test(item)));
  assert.ok(context.jobEvidence.length > 0);
  assert.ok(context.recentTranscript.includes("infrastructure reliability"));
});

test("classifies screen text from terminal and extracts operational errors", () => {
  const screen = createScreenContextFromText(`
    $ kubectl get pods
    Error from server (Forbidden): pods is forbidden: User cannot list resource pods
  `);

  assert.equal(screen.sourceType, "terminal");
  assert.ok(screen.errorMessages.length > 0);
  assert.equal(screen.detectedLanguage, "Shell");
});

test("generates a post-interview report from transcript text", () => {
  const report = generateInterviewReport({
    sessionId: "session-1",
    transcriptText:
      "Tell me about a time you improved deployment reliability. I automated Terraform modules and reduced failed deployments by 40%. How would you debug Kubernetes pods that are forbidden?",
  });

  assert.equal(report.sessionId, "session-1");
  assert.ok(report.questions.length >= 2);
  assert.ok(report.strongAnswers.length > 0);
  assert.ok(report.likelyFollowUpQuestions.length > 0);
});
