import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { test } from "node:test";

type PromptRepositoryModule = typeof import("../../lib/prompt-vault-persistence");
type TranscriptRepositoryModule = typeof import("../../lib/transcription-persistence");

test("failed authenticated cloud deletes reject without writing unrelated local storage", async () => {
  // The production app resolves @/ through Next; the compiled Node test runner needs the same mapping.
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  let cloudError: { message: string } | null = { message: "permission denied" };
  let localWrites = 0;
  let authUser: { id: string } | null = { id: "owner-a" };
  let authError: { name: string; message: string } | null = null;
  const filters: Array<[string, string]> = [];
  const fakeSupabase = {
    auth: { getUser: async () => ({ data: { user: authUser }, error: authError }) },
    from: () => ({ delete: () => ({
      eq: (key: string, value: string) => {
        filters.push([key, value]);
        return { eq: async (nextKey: string, nextValue: string) => {
          filters.push([nextKey, nextValue]);
          return { error: cloudError };
        } };
      },
    }) }),
  };
  loader._load = (id, ...args) => {
    if (id === "@/lib/supabase") return { supabase: fakeSupabase, supabaseConfigError: "" };
    if (id.startsWith("@/")) return originalLoad.call(Module, path.resolve(__dirname, "../..", id.slice(2)), ...args);
    return originalLoad.call(Module, id, ...args);
  };
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => "[]", setItem: () => { localWrites += 1; } },
  } });
  try {
    const prompts = (require("../../lib/prompt-vault-persistence") as PromptRepositoryModule).createPromptVaultRepository();
    const transcripts = (require("../../lib/transcription-persistence") as TranscriptRepositoryModule).createTranscriptionRepository();
    await assert.rejects(prompts.deletePrompt("cloud-prompt"), /permission denied/);
    await assert.rejects(transcripts.deleteTranscript("cloud-transcript"), /permission denied/);
    assert.equal(localWrites, 0);
    assert.deepEqual(filters, [["id", "cloud-prompt"], ["user_id", "owner-a"], ["id", "cloud-transcript"], ["user_id", "owner-a"]]);
    cloudError = null;
    assert.equal((await prompts.deletePrompt("cloud-prompt")).source, "remote");
    assert.equal((await transcripts.deleteTranscript("cloud-transcript")).source, "remote");
    assert.equal(localWrites, 0);
    authUser = null;
    authError = { name: "AuthRetryableFetchError", message: "auth offline" };
    await assert.rejects(prompts.deletePrompt("unknown-prompt"), /authentication could not be verified/);
    await assert.rejects(transcripts.deleteTranscript("unknown-transcript"), /authentication could not be verified/);
    assert.equal(localWrites, 0);
    authError = null;
    await assert.rejects(prompts.deletePrompt("cloud-prompt"), /authentication could not be verified/);
    await assert.rejects(transcripts.deleteTranscript("cloud-transcript"), /authentication could not be verified/);
    assert.equal(localWrites, 0);
    assert.equal((await prompts.deletePrompt("local-prompt")).source, "local");
    assert.equal((await transcripts.deleteTranscript("local-transcript")).source, "local");
    assert.equal(localWrites, 2);
    authError = { name: "AuthSessionMissingError", message: "Auth session missing!" };
    assert.equal((await prompts.deletePrompt("local-prompt")).source, "local");
    assert.equal((await transcripts.deleteTranscript("local-transcript")).source, "local");
    await assert.rejects(prompts.deletePrompt("cloud-prompt"), /authentication could not be verified/);
    await assert.rejects(transcripts.deleteTranscript("cloud-transcript"), /authentication could not be verified/);
    assert.equal(localWrites, 4);
  } finally {
    loader._load = originalLoad;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
