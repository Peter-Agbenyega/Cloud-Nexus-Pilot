import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../../app/api/mock-interview/route";

for (const body of ["null", "[]", '"text"', "42", "true", "{broken", ""]) {
  test(`rejects non-object or malformed JSON: ${JSON.stringify(body)}`, async () => {
    const response = await POST(new Request("https://example.invalid/api/mock-interview", {
      method: "POST", body, headers: { "Content-Type": "application/json" },
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Request body must be a JSON object." });
  });
}
test("accepts a synthetic interview object", async () => {
  const response = await POST(new Request("https://example.invalid/api/mock-interview", {
    method: "POST", body: JSON.stringify({ role: "Cloud Engineer", interviewMode: "aws" }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).nextQuestion);
});
