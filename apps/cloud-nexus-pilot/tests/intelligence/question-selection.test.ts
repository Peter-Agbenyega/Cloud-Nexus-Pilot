import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDetectedQuestion, detectedQuestionKey, latestCompleteQuestion, selectDetectedQuestion, shouldReplaceDetectedQuestion, questionNormalizationCandidate } from "../../features/transcription/question-selection";

const question = "What is Kubernetes?";
const noise = "Cloud Nexus Pilot is an AI interview copilot. Common phrases include microphone transcription, tab audio, resume studio, culture scanner.";
const segments = (...texts: string[]) => texts.map(text => ({ text }));

test("a complete short question survives following nonquestion and empty chunks", () => {
  for (const following of ["", "Thank you.", noise, "How would you"]) {
    const next = selectDetectedQuestion(segments(question, following), null);
    assert.equal(next, question);
    assert.equal(shouldReplaceDetectedQuestion(question, next), false);
  }
});

test("question extraction excludes narration appended to the same saved chunk", () => {
  const next = latestCompleteQuestion(segments(`${question} ${noise}`));
  assert.equal(next, question);
  assert.equal(bindDetectedQuestion(`${question} ${noise}`, segments(question), segments(question))?.question, question);
  assert.equal(latestCompleteQuestion(segments(noise)), "");
});

test("format-only detector updates neither cancel nor duplicate the answer", () => {
  for (const next of ["  WHAT   IS KUBERNETES ?  ", "What is Kubernetes.", "What is Kubernetes"]) {
    assert.equal(shouldReplaceDetectedQuestion(question, next), false);
    assert.equal(detectedQuestionKey(question), detectedQuestionKey(next));
  }
  assert.equal(shouldReplaceDetectedQuestion(question, ""), false);
});

test("the newest complete local question supersedes old asynchronous detection", () => {
  const changed = "How does Kubernetes schedule pods?";
  const next = selectDetectedQuestion(segments(question, noise, changed), bindDetectedQuestion(question, segments(question), segments(question)));
  assert.equal(next, changed);
  assert.equal(shouldReplaceDetectedQuestion(question, next), true);
  const corrected = latestCompleteQuestion(segments("What is a Kubernetes deployment?"));
  assert.equal(shouldReplaceDetectedQuestion(question, corrected), true);
});

test("technical symbols remain meaningful and internal dots do not split questions", () => {
  assert.equal(latestCompleteQuestion(segments("What is Node.js?")), "What is Node.js?");
  assert.equal(shouldReplaceDetectedQuestion("What is C++?", "What is C#?"), true);
});

test("incomplete prompts wait while a complete implicit interview prompt is accepted", () => {
  assert.equal(latestCompleteQuestion(segments("Can you tell me", "Tell me about a time you")), "");
  const prompt = "Walk me through how you would debug a failing Kubernetes deployment.";
  assert.equal(latestCompleteQuestion(segments(prompt)), prompt);
  assert.equal(latestCompleteQuestion([]), "");
  assert.equal(selectDetectedQuestion(segments(noise), null), "");
});

test("a question split across saved segments retains its opening words", () => {
  assert.equal(latestCompleteQuestion(segments("What is", "Kubernetes?")), question);
  assert.equal(latestCompleteQuestion(segments("What is", "a Kubernetes", "deployment?")), "What is a Kubernetes deployment?");
});

test("answered question A survives partial B without replay, then yields to completed B", () => {
  const oldKey = detectedQuestionKey(question);
  const waiting = latestCompleteQuestion(segments(question, "How would you"));
  assert.equal(waiting, question);
  assert.equal(detectedQuestionKey(waiting), oldKey);
  assert.equal(shouldReplaceDetectedQuestion(question, waiting), false);
  const next = latestCompleteQuestion(segments(question, "How would you", "debug a failing Kubernetes pod?"));
  assert.equal(next, "How would you debug a failing Kubernetes pod?");
  assert.equal(shouldReplaceDetectedQuestion(question, next), true);
  assert.notEqual(detectedQuestionKey(next), oldKey);
});

test("an independent new question does not inherit an abandoned partial prompt", () => {
  const next = latestCompleteQuestion(segments(question, "How would you", "What is Terraform?"));
  assert.equal(next, "What is Terraform?");
});

test("a fresh AI completion of short B replaces retained A and survives following noise or partial C", () => {
  const requested = segments(question, "How do Docker containers communicate");
  const corrected = "How do Docker containers communicate?";
  const bound = bindDetectedQuestion(corrected, requested, requested);
  assert.ok(bound);
  assert.equal(latestCompleteQuestion(requested), question);
  assert.equal(selectDetectedQuestion(requested, bound), corrected);
  assert.equal(selectDetectedQuestion([...requested, ...segments(noise, "How would you")], bound), corrected);
  assert.equal(bindDetectedQuestion("", requested, requested), null);
  const next = [...requested, ...segments("What is Terraform?")];
  assert.equal(selectDetectedQuestion(next, bound), "What is Terraform?");
});

test("delayed AI results cannot override a newer question or revised source", () => {
  const requested = segments(question, "How do Docker containers communicate");
  const next = [...requested, ...segments("What is Terraform?")];
  assert.equal(bindDetectedQuestion("How do Docker containers communicate?", requested, next), null);
  const revised = segments(question, "How do Docker containers share storage?");
  assert.equal(bindDetectedQuestion("How do Docker containers communicate?", requested, revised), null);
  const bound = bindDetectedQuestion("How do Docker containers communicate?", requested, requested);
  assert.equal(selectDetectedQuestion(revised, bound), "How do Docker containers share storage?");
});

test("nonquestion additions do not invalidate an in-flight detector correction", () => {
  const requested = segments(question, "How do Docker containers communicate");
  // A complete sentence boundary keeps unrelated narration out of the raw candidate.
  const sentence = segments(question, "How do Docker containers communicate.");
  const current = [...sentence, ...segments(noise)];
  const bound = bindDetectedQuestion("How do Docker containers communicate?", sentence, current);
  assert.ok(bound);
  assert.equal(selectDetectedQuestion(current, bound), "How do Docker containers communicate?");
  assert.equal(bindDetectedQuestion("How do Docker containers communicate?", requested, [...requested, ...segments("What is")]), null);
});


test("complete local questions bypass normalization while newest unresolved prompts keep the correction fallback", () => {
  assert.equal(questionNormalizationCandidate(segments(question)), null);
  assert.equal(questionNormalizationCandidate(segments(question, noise)), null);
  assert.equal(questionNormalizationCandidate(segments(question, "What is")), null);
  assert.equal(questionNormalizationCandidate(segments("What is", "Kubernetes?")), null);
  const current = segments(question, "How do Docker containers communicate");
  const candidate = questionNormalizationCandidate(current);
  assert.ok(candidate);
  assert.equal(candidate.question, "How do Docker containers communicate");
  const corrected = bindDetectedQuestion("How do Docker containers communicate?", current, current);
  assert.ok(corrected);
  assert.equal(questionNormalizationCandidate(current, corrected.sourceKey), null);
  assert.equal(questionNormalizationCandidate([...current, ...segments("Thank you.")], corrected.sourceKey), null);
  assert.equal(questionNormalizationCandidate([...current, ...segments("What is Terraform?")], corrected.sourceKey), null);
  assert.equal(questionNormalizationCandidate([...current, ...segments("How does Kubernetes schedule workloads")], corrected.sourceKey)?.question, "How does Kubernetes schedule workloads");
});
