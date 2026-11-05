import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGuidancePreview } from "../../lib/interview-intelligence/guidance-preview";
import { buildInterviewSystemPrompt } from "../../lib/interview-intelligence/natural-speaking";

test("preview decodes a top-level speakNow value as complete words arrive", () => {
  assert.equal(extractGuidancePreview('{"speakNow":"Kuber'), null);
  assert.equal(extractGuidancePreview('{"speakNow":"Kubernetes manages con'), "Kubernetes manages");
  assert.equal(extractGuidancePreview('{"speakNow":"Yes."'), "Yes.");
  assert.equal(extractGuidancePreview('{"headline":"Containers","speakNow":"Kubernetes manages containers."'), "Kubernetes manages containers.");
});

test("preview never leaks JSON syntax, incomplete escapes or nested field impersonation", () => {
  const opening = '{"speakNow":"Use the ';
  const escaped = opening + '\\u004bubernetes and \\"safe\\" commands."';
  assert.equal(extractGuidancePreview(escaped), 'Use the Kubernetes and "safe" commands.');
  assert.equal(extractGuidancePreview(opening + '\\u00'), null);
  assert.equal(extractGuidancePreview('{"speakNow":"Kubernetes manages \\q'), null);
  assert.equal(extractGuidancePreview('{"example":{"speakNow":"Nested spoof"},"headline":"Hi"}'), null);
  assert.equal(extractGuidancePreview('{"example":{"speakNow":"Nested spoof"},"speakNow":"Actual top-level answer."'), "Actual top-level answer.");
  assert.equal(extractGuidancePreview('{"headline":"speakNow: fake","speakNow":false}'), null);
});

test("every JSON-string split yields only a decoded answer prefix", () => {
  const text = 'Kubernetes manages containers and safely applies "desired state" changes.';
  const raw = JSON.stringify({ speakNow: text, keyPoints: ["Scaling"] });
  let previous = "";
  for (let index = 1; index <= raw.length; index += 1) {
    const result = extractGuidancePreview(raw.slice(0, index));
    if (result !== null) {
      assert.ok(text.startsWith(result), `unexpected prefix at ${index}`);
      assert.ok(result.startsWith(previous), `preview moved backward at ${index}`);
      previous = result;
    }
  }
  assert.equal(previous, text);
  assert.equal(extractGuidancePreview("x".repeat(32_769)), null);
});

test("guidance prompt requests direct speakNow first without generating duplicate aliases", () => {
  const prompt = buildInterviewSystemPrompt({ mode: "kubernetes", category: "kubernetes" });
  assert.match(prompt, /JSON shape, in this order: \{speakNow, headline/);
  assert.match(prompt, /at most 60 words/);
  assert.match(prompt, /Do not repeat fields under legacy aliases/);
  assert.match(prompt, /Never fabricate candidate experience/);
  assert.match(prompt, /Maintain strong depth/);
});
