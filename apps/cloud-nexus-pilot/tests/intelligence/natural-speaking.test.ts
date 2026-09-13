import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDebuggingPrompt,
  buildInterviewSystemPrompt,
  buildInterviewUserPrompt,
  buildSystemDesignPrompt,
  buildTechnicalPrompt,
  hasCandidateEvidence,
} from "../../lib/interview-intelligence/natural-speaking";

const BLOCKED_OPENERS = ["Certainly", "Sure", "As an AI", "In conclusion", "It is important to note"];

test("natural speaking policy rejects routine AI-style openings", () => {
  const prompt = buildInterviewSystemPrompt({ mode: "aws", category: "cloud" });

  for (const opener of BLOCKED_OPENERS) {
    assert.match(prompt, new RegExp(`Do not begin with[^\\n]*${opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  }
});

test("technical prompt keeps speak-now concise while preserving deeper detail", () => {
  const prompt = buildInterviewSystemPrompt({ mode: "devops", category: "devops" });

  assert.match(prompt, /speakNow: 2-4 short sentences/i);
  assert.match(prompt, /technicalDetail: deeper reasoning/i);
  assert.match(buildTechnicalPrompt(), /15-30 second practical response/i);
  assert.match(buildTechnicalPrompt(), /For AWS specifically/i);
});

test("candidate evidence policy allows personalization without invented experience", () => {
  const withEvidence = "Candidate evidence:\n- Built Terraform modules for AWS networking";
  const withoutEvidence = "Candidate evidence: none provided. Do not invent experience.";
  const prompt = buildInterviewSystemPrompt({ mode: "behavioral", category: "behavioral" });

  assert.equal(hasCandidateEvidence(withEvidence), true);
  assert.equal(hasCandidateEvidence(withoutEvidence), false);
  assert.match(prompt, /Never fabricate candidate experience/i);
  assert.match(prompt, /I haven't dealt with that exact scenario in production/i);
});

test("debugging prompt starts with actionable diagnosis", () => {
  const prompt = buildDebuggingPrompt();

  assert.match(prompt, /Start with the likely root cause/i);
  assert.match(prompt, /next safe action or read-only command/i);
  assert.match(prompt, /The first thing I'd check is/i);
});

test("behavioral prompt stays natural and does not expose template labels", () => {
  const prompt = buildInterviewSystemPrompt({ mode: "behavioral", category: "behavioral" });

  assert.match(prompt, /without visible labels/i);
  assert.match(prompt, /At my last role/i);
  assert.doesNotMatch(prompt, /Situation:\s*Task:\s*Action:\s*Result:/i);
});

test("system design prompt separates architecture direction from components", () => {
  const prompt = buildSystemDesignPrompt();

  assert.match(prompt, /Start with the architecture direction/i);
  assert.match(prompt, /entry point, compute, persistence, resilience/i);
  assert.match(prompt, /trade-off I'd call out/i);
});

test("user prompt carries context without asking to repeat the question", () => {
  const prompt = buildInterviewUserPrompt({
    question: "How would you design a resilient AWS web app?",
    packedContext: "Candidate evidence:\n- Built ALB and ECS services",
    mode: "system-design",
    category: "system_design",
  });

  assert.match(prompt, /How would you design a resilient AWS web app/);
  assert.match(prompt, /Built ALB and ECS services/);
  assert.match(prompt, /Make speakNow sound like something the candidate can say out loud/i);
});
