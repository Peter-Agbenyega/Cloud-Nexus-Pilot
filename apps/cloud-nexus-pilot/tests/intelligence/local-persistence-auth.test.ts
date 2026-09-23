import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSafeReturnPath, isLocalFallbackPath, isProtectedPilotPath } from "../../lib/auth-return-path";
import { resolveStoredPromptVaultItems, PROMPT_VAULT_STARTERS } from "../../lib/prompt-vault";

test("saved empty Prompt Vault stays empty across reads and subsequent writes", () => {
  let storage = JSON.stringify(PROMPT_VAULT_STARTERS);
  for (const item of PROMPT_VAULT_STARTERS) {
    storage = JSON.stringify(resolveStoredPromptVaultItems(storage).filter((entry) => entry.id !== item.id));
  }
  assert.deepEqual(resolveStoredPromptVaultItems(storage), []);
  assert.deepEqual(resolveStoredPromptVaultItems(" [ ] "), []);
  storage = JSON.stringify([PROMPT_VAULT_STARTERS[0], ...resolveStoredPromptVaultItems(storage)]);
  assert.equal(resolveStoredPromptVaultItems(storage).length, 1);
});

test("missing and malformed Prompt Vault storage retain prior starter fallback", () => {
  for (const stored of [null, "", "not-json", "null", "{}", "[null,42]"]) {
    assert.deepEqual(resolveStoredPromptVaultItems(stored), PROMPT_VAULT_STARTERS);
  }
});

test("auth return paths cannot escape origin through URL normalization", () => {
  for (const unsafe of [null, "https://evil.example", "//evil.example", "/\\evil.example", "/\n/evil.example", "/\t/evil.example", "javascript:alert(1)"]) {
    assert.equal(resolveSafeReturnPath(unsafe), "/prompt-library");
  }
  assert.equal(resolveSafeReturnPath("/workspace?mode=local#notes"), "/workspace?mode=local#notes");
  assert.equal(resolveSafeReturnPath("/transcripts"), "/transcripts");
});

test("local fallback eligibility preserves billing authentication and route boundaries", () => {
  for (const path of ["/workspace", "/workspace/session", "/transcripts", "/summary", "/prompt-library"]) {
    assert.equal(isLocalFallbackPath(path), true);
    assert.equal(isProtectedPilotPath(path), true);
  }
  for (const path of ["/billing", "/billing/success"]) {
    assert.equal(isLocalFallbackPath(path), false);
    assert.equal(isProtectedPilotPath(path), true);
  }
  for (const path of ["/workspace-evil", "/billing-other", "/api/transcribe", "/auth/login"]) {
    assert.equal(isLocalFallbackPath(path), false);
    assert.equal(isProtectedPilotPath(path), false);
  }
});
