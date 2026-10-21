import assert from "node:assert/strict";
import test from "node:test";
import { sourceLoader } from "./route-test-loader.mjs";

const load = sourceLoader({ "@/lib/supabase": { supabase: null } });
const { createInterviewReportRepository, createReportOwnerTracker, readReportTranscriptOptions, INTERVIEW_REPORT_STORAGE_KEY } = load("@/lib/interview-report-persistence");
const { generateInterviewReport } = load("@/lib/interview-intelligence/report");

function report() {
  return generateInterviewReport({ sessionId: "local-summary-session", transcriptText: "How did you diagnose the outage? I checked the metrics and restored service." });
}

function memoryStorage(initial = new Map()) {
  return { values: initial, writes: 0, fail: false,
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { if (this.fail) throw Error("quota"); this.writes++; this.values.set(key, value); },
  };
}

function cloud() {
  const state = { owner: "owner-a", authError: null, authThrows: false, rows: { interview_sessions: [], interview_reports: [] }, calls: [], failTable: null, lostAck: false, readError: false, overrideRows: null, afterSession: null, afterRead: null };
  const client = {
    auth: { async getUser() { if (state.authThrows) throw Error("PRIVATE_AUTH_DETAIL"); return { data: { user: state.owner ? { id: state.owner } : null }, error: state.authError }; } },
    from(table) {
      const filters = [];
      const query = {
        async upsert(row, options) {
          state.calls.push({ kind: "upsert", table, row, options });
          if (state.failTable === table) return { error: { message: "PRIVATE_DATABASE_DETAIL" } };
          if (!state.rows[table].some((item) => item.id === row.id)) state.rows[table].push(structuredClone(row));
          if (table === "interview_sessions") state.afterSession?.();
          if (table === "interview_reports" && state.lostAck) { state.lostAck = false; throw Error("PRIVATE_LOST_ACK_DETAIL"); }
          return { error: null };
        },
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        order() { return query; },
        result(single) {
          state.calls.push({ kind: "read", table, filters: [...filters] });
          const rows = state.overrideRows ?? state.rows[table].filter((row) => filters.every(([key, value]) => row[key] === value));
          state.afterRead?.();
          return { data: single ? rows[0] ?? null : rows, error: state.readError ? { message: "PRIVATE_READ_DETAIL" } : null };
        },
        async maybeSingle() { return query.result(true); },
        then(resolve, reject) { return Promise.resolve(query.result(false)).then(resolve, reject); },
      };
      return query;
    },
  };
  return { state, client };
}

test("same-owner auth refocus preserves pending retry; actual switch/sign-out invalidates it", () => {
  let retry = { id: "pending-report" }; let invalidations = 0;
  const tracker = createReportOwnerTracker(() => { retry = null; invalidations++; });
  assert.equal(tracker.observe("owner-a"), false);
  assert.equal(tracker.observe("owner-a"), false);
  assert.deepEqual(retry, { id: "pending-report" }); assert.equal(invalidations, 0);
  assert.equal(tracker.observe("owner-b"), true); assert.equal(retry, null);
  retry = { id: "owner-b-report" };
  assert.equal(tracker.observe(null), true); assert.equal(retry, null); assert.equal(invalidations, 2);
  assert.equal(tracker.observe(null), false); assert.equal(invalidations, 2);
});

test("report input picker excludes foreign, guest-to-account, unknown-owner and malformed transcripts", () => {
  const entry = { id: "guest", title: "Owned sample", transcriptText: "Synthetic question?", updatedAt: 1, ownerScope: "local-user", ownerId: null };
  const storage = memoryStorage(new Map([["cloudnexus.transcripts.v1", JSON.stringify([
    entry, { ...entry, id: "a", ownerScope: "authenticated-user", ownerId: "owner-a" },
    { ...entry, id: "b", ownerScope: "authenticated-user", ownerId: "owner-b" },
    { id: "unknown", title: "Unverified owner", transcriptText: "Do not select" }, null,
  ])]]));
  assert.deepEqual(readReportTranscriptOptions(null, storage).map((record) => record.id), ["guest"]);
  assert.deepEqual(readReportTranscriptOptions("owner-a", storage).map((record) => record.id), ["a"]);
  assert.deepEqual(readReportTranscriptOptions("owner-b", storage).map((record) => record.id), ["b"]);
  assert.equal(storage.writes, 0);
});

test("guest report survives repository reload and retry does not duplicate or overwrite", async () => {
  const storage = memoryStorage(); const original = report();
  const repo = createInterviewReportRepository({ client: null, storage });
  await repo.save(original, null);
  await repo.save({ ...original, strongAnswers: ["changed"] }, null);
  const reloaded = await createInterviewReportRepository({ client: null, storage }).list();
  assert.deepEqual(reloaded.reports.map((saved) => saved.report), [original]);
  assert.equal(reloaded.reports[0].source, "local"); assert.equal(storage.writes, 1);
});

test("cloud report reloads from account rows, never from guest storage", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); const original = report();
  await createInterviewReportRepository({ client: null, storage }).save(report(), null);
  const saved = await createInterviewReportRepository({ client, storage }).save(original, "owner-a");
  const loaded = await createInterviewReportRepository({ client, storage }).list();
  assert.deepEqual(loaded.reports, [saved]); assert.equal(saved.ownerId, "owner-a"); assert.equal(saved.source, "remote");
  assert.equal(saved.report.sessionId, state.rows.interview_sessions[0].id);
  assert.equal(state.rows.interview_sessions[0].status, "ended");
  for (const call of state.calls.filter((call) => call.kind === "read")) assert.ok(call.filters.some(([key, value]) => key === "user_id" && value === "owner-a"));
});

test("account B cannot list account A or guest reports; sign-out reveals guest scope only", async () => {
  const { state, client } = cloud(); const storage = memoryStorage();
  const guest = report(); await createInterviewReportRepository({ client: null, storage }).save(guest, null);
  const repo = createInterviewReportRepository({ client, storage }); await repo.save(report(), "owner-a");
  state.owner = "owner-b"; assert.deepEqual((await repo.list()).reports, []);
  state.owner = null; assert.deepEqual((await repo.list()).reports.map((item) => item.report), [guest]);
});

test("pending save refuses account switch before any database or browser write", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); state.owner = "owner-b";
  await assert.rejects(createInterviewReportRepository({ client, storage }).save(report(), "owner-a"), /account changed/);
  assert.equal(state.calls.length, 0); assert.equal(storage.writes, 0);
});

test("account switch between session and report write stops the report write", async () => {
  const { state, client } = cloud(); state.afterSession = () => { state.owner = "owner-b"; };
  await assert.rejects(createInterviewReportRepository({ client, storage: memoryStorage() }).save(report(), "owner-a"), /account changed/);
  assert.equal(state.rows.interview_reports.length, 0); assert.equal(state.rows.interview_sessions.length, 1);
});

test("late reads after account switch are rejected rather than returned to another user", async () => {
  const { state, client } = cloud(); const repo = createInterviewReportRepository({ client, storage: memoryStorage() });
  await repo.save(report(), "owner-a"); state.afterRead = () => { state.owner = "owner-b"; };
  await assert.rejects(repo.list(), /account changed/);
});

test("returned foreign row is rejected even if a client ignores the owner query filter", async () => {
  const { state, client } = cloud(); const repo = createInterviewReportRepository({ client, storage: memoryStorage() });
  await repo.save(report(), "owner-a"); state.overrideRows = [{ ...state.rows.interview_reports[0], user_id: "owner-b" }];
  await assert.rejects(repo.list(), /ownership/);
});

test("lost report acknowledgement retries the same IDs without duplicate session/report or overwrite", async () => {
  const { state, client } = cloud(); const original = report(); const storage = memoryStorage();
  const repo = createInterviewReportRepository({ client, storage }); state.lostAck = true;
  await assert.rejects(repo.save(original, "owner-a"), /save was not confirmed/);
  const saved = await repo.save({ ...original, strongAnswers: ["retry must not overwrite"] }, "owner-a");
  assert.deepEqual(saved.report.strongAnswers, original.strongAnswers);
  assert.equal(state.rows.interview_sessions.length, 1); assert.equal(state.rows.interview_reports.length, 1); assert.equal(storage.writes, 0);
  const restarted = createInterviewReportRepository({ client, storage });
  assert.deepEqual((await restarted.list()).reports, [saved]);
});

test("session failure does not write a report or fall back to browser success", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); state.failTable = "interview_sessions";
  await assert.rejects(createInterviewReportRepository({ client, storage }).save(report(), "owner-a"), /session could not be saved/);
  assert.equal(state.rows.interview_reports.length, 0); assert.equal(storage.writes, 0);
});

test("report write rejection remains a failure and retry reuses the owned session", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); const original = report();
  const repo = createInterviewReportRepository({ client, storage }); state.failTable = "interview_reports";
  await assert.rejects(repo.save(original, "owner-a"), /save was not confirmed/);
  assert.equal(state.rows.interview_reports.length, 0); assert.equal(storage.writes, 0);
  state.failTable = null; await repo.save(original, "owner-a");
  assert.equal(state.rows.interview_sessions.length, 1); assert.equal(state.rows.interview_reports.length, 1);
});

test("identical client IDs in separate accounts produce separate owned report and session IDs", async () => {
  const { state, client } = cloud(); const original = report(); const repo = createInterviewReportRepository({ client, storage: memoryStorage() });
  const first = await repo.save(original, "owner-a"); state.owner = "owner-b";
  const second = await repo.save({ ...original, strongAnswers: ["account B content"] }, "owner-b");
  assert.notEqual(first.report.id, second.report.id); assert.notEqual(first.report.sessionId, second.report.sessionId);
  assert.deepEqual((await repo.list()).reports, [second]);
  assert.deepEqual(state.rows.interview_reports.find((row) => row.user_id === "owner-a").strong_answers, original.strongAnswers);
});

test("unconfirmed read after cloud write is retryable and never duplicates the committed record", async () => {
  const { state, client } = cloud(); const original = report(); const repo = createInterviewReportRepository({ client, storage: memoryStorage() });
  state.readError = true; await assert.rejects(repo.save(original, "owner-a"), /could not be confirmed/);
  state.readError = false; await repo.save(original, "owner-a");
  assert.equal(state.rows.interview_sessions.length, 1); assert.equal(state.rows.interview_reports.length, 1);
});

test("auth outages and thrown SDK errors do not read guest reports or mutate storage", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); const repo = createInterviewReportRepository({ client, storage });
  state.authError = { name: "AuthApiError" }; await assert.rejects(repo.list(), /account could not be verified/);
  state.authError = null; state.authThrows = true; await assert.rejects(repo.save(report(), "owner-a"), /account could not be verified/);
  assert.equal(state.calls.length, 0); assert.equal(storage.writes, 0);
});

test("expected missing session supports guest mode while storage errors stay explicit", async () => {
  const { state, client } = cloud(); const storage = memoryStorage(); state.owner = null; state.authError = { name: "AuthSessionMissingError" };
  const repo = createInterviewReportRepository({ client, storage }); await repo.save(report(), null);
  const before = storage.values.get(INTERVIEW_REPORT_STORAGE_KEY); storage.fail = true;
  await assert.rejects(repo.save(report(), null), /storage could not save/); assert.equal(storage.values.get(INTERVIEW_REPORT_STORAGE_KEY), before);
});

test("corrupt guest storage and malformed report fail without replacing existing data", async () => {
  const storage = memoryStorage(new Map([[INTERVIEW_REPORT_STORAGE_KEY, "invalid JSON"]]));
  const repo = createInterviewReportRepository({ client: null, storage });
  await assert.rejects(repo.list(), /could not be read/); await assert.rejects(repo.save(report(), null), /could not be read/);
  await assert.rejects(repo.save({ id: "broken" }, null), /invalid/); assert.equal(storage.writes, 0);
});
