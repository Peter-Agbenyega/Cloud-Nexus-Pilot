import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeProviderUser, providerAuthUnavailable } from "../../lib/server/provider-auth-policy";

test("provider auth fails closed when authentication is unconfigured", () => {
  assert.equal(providerAuthUnavailable().response?.status, 503);
});

test("provider auth rejects absent and invalid sessions", async () => {
  const missing = await authorizeProviderUser(async () => ({ data: { user: null }, error: null }));
  assert.equal(missing.response?.status, 401);
  const invalid = await authorizeProviderUser(async () => ({ data: { user: { id: "user-a", role: "authenticated" } }, error: new Error("invalid token") }));
  assert.equal(invalid.response?.status, 401);
});

test("provider auth rejects service roles, anonymous accounts and role-less identities", async () => {
  for (const user of [
    { id: "admin", role: "service_role" },
    { id: "user-a" },
    { id: "user-a", role: "authenticated", is_anonymous: true },
    { id: "", role: "authenticated" },
  ]) {
    const result = await authorizeProviderUser(async () => ({ data: { user }, error: null }));
    assert.equal(result.response?.status, 403);
  }
});

test("provider auth returns the verified ordinary user's ID", async () => {
  const result = await authorizeProviderUser(async () => ({ data: { user: { id: "user-a", role: "authenticated", is_anonymous: false } }, error: null }));
  assert.deepEqual(result, { userId: "user-a" });
});

test("authentication outages do not authorize provider access or leak errors", async () => {
  const result = await authorizeProviderUser(async () => { throw new Error("private upstream details"); });
  assert.equal(result.response?.status, 503);
  assert.doesNotMatch(await result.response!.text(), /private upstream details/);
});
