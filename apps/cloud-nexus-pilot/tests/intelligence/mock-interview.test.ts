import assert from "node:assert/strict";
import { test } from "node:test";

import { runMockInterviewTurn } from "../../lib/interview-intelligence/mock-interview";

test("mock interview asks role-specific first question using shared profile context", () => {
  const result = runMockInterviewTurn({
    resumeText: "Senior DevOps Engineer. Automated Terraform and led AWS IAM remediation.",
    jobDescriptionText: "Required: AWS, Terraform, Kubernetes, CI/CD.",
    role: "Senior Platform Engineer",
    companyContext: "Cloud platform team",
    difficulty: "senior",
    interviewMode: "devops",
    history: [],
  });

  assert.ok(result.nextQuestion);
  assert.match(result.nextQuestion, /Senior Platform Engineer/);
  assert.equal(result.report, null);
});

test("mock interview scores candidate answers and asks follow-up prompts", () => {
  const result = runMockInterviewTurn({
    resumeText: "Led Terraform automation and reduced failed deployments by 40%.",
    jobDescriptionText: "Required: Terraform and AWS.",
    role: "DevOps Engineer",
    companyContext: "",
    difficulty: "senior",
    interviewMode: "terraform-iac",
    history: [
      {
        id: "turn-1",
        role: "interviewer",
        text: "How would you structure Terraform modules?",
        createdAt: "2026-09-10T12:00:00.000Z",
      },
      {
        id: "turn-2",
        role: "candidate",
        text: "I automated Terraform modules, reduced failed deployments by 40%, and considered rollout risk.",
        createdAt: "2026-09-10T12:01:00.000Z",
      },
    ],
  });

  assert.ok((result.score ?? 0) >= 7);
  assert.ok(result.feedback);
  assert.ok(result.followUp || result.nextQuestion);
});

test("mock interview can finish with a report", () => {
  const result = runMockInterviewTurn({
    resumeText: "",
    jobDescriptionText: "",
    role: "Cloud Engineer",
    companyContext: "",
    difficulty: "mid",
    interviewMode: "aws",
    finish: true,
    history: [
      {
        id: "turn-1",
        role: "interviewer",
        text: "How would you debug an AWS IAM AccessDenied error?",
        createdAt: "2026-09-10T12:00:00.000Z",
      },
      {
        id: "turn-2",
        role: "candidate",
        text: "I would identify the caller, denied action, resource, and check explicit denies first.",
        createdAt: "2026-09-10T12:01:00.000Z",
      },
    ],
  });

  assert.equal(result.nextQuestion, null);
  assert.ok(result.report);
  assert.ok(result.report?.likelyFollowUpQuestions.length);
});
