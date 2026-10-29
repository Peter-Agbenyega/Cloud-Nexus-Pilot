import type { ProviderAuthorization } from "./provider-auth-policy";
import { RequestBoundaryError, processingScope, readBoundedBytes } from "./request-boundary";

export type Principal = Extract<ProviderAuthorization, { userId: string }>;
export type SavedSession = { sessionId: string; status: string; createdAt: number; events: Array<{ sequence: number; [key: string]: unknown }>; guidance?: unknown[]; hasMore?: boolean; nextCursor?: number };
export type Reservation = { acquired: boolean; state: string; result?: unknown };

export function assertSettlementCredential(token = process.env.PILOT_PROCESSING_SERVICE_KEY): void {
  // This is a fail-closed expiry preflight, not signature verification or a new
  // principal boundary. PostgREST still verifies the actual trusted JWT.
  try {
    if (!token) throw new Error();
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: unknown; role?: unknown };
    if (claims.role !== "service_role" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() + 30_000) throw new Error();
  } catch {
    throw new RequestBoundaryError(503, "processing_settlement_unavailable", "Transcription saving is unavailable: the server processing credential is missing or expired. Ask the server operator to restore processing access; saved work remains available.");
  }
}

// Uses the existing GoTrue identity and PostgREST contract. No hosted account,
// service provisioning, or alternate login mechanism is created here.
async function rpc(principal: Principal, name: string, args: Record<string, unknown>, signal?: AbortSignal, trusted = false): Promise<unknown> {
  const base = (process.env.PILOT_DATA_API_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = trusted ? process.env.PILOT_PROCESSING_SERVICE_KEY : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const token = trusted ? key : principal.accessToken;
  if (!base || !key || !token) throw new RequestBoundaryError(503, "processing_store_unavailable", "Owned processing storage is not configured.");
  const scope = processingScope(signal ?? new AbortController().signal, 8_000);
  try {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: key, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args), signal: scope.signal, cache: "no-store",
    });
    if (!response.ok) {
      // Never return raw database error strings, SQL, tokens or upstream payloads.
      const raw = await readBoundedBytes(new Request("http://localhost/result", { method: "POST", body: response.body, duplex: "half", signal: scope.signal } as RequestInit), 16_384);
      let message = "";
      try { message = String((JSON.parse(new TextDecoder().decode(raw)) as { message?: unknown }).message ?? ""); } catch { /* safe generic error */ }
      if (/quota_exhausted|processing_busy/.test(message)) throw new RequestBoundaryError(429, "quota_exhausted", "Processing allowance or concurrency is exhausted. Retry later.");
      if (/session_unavailable/.test(message)) throw new RequestBoundaryError(404, "transcript_stream_session_missing", "The session is unavailable.");
      if (/operation_conflict/.test(message)) throw new RequestBoundaryError(409, "operation_conflict", "This operation cannot be repeated with different input.");
      throw new RequestBoundaryError(503, "processing_store_unavailable", "Owned processing storage could not acknowledge the operation.");
    }
    const bytes = await readBoundedBytes(new Request("http://localhost/result", { method: "POST", body: response.body, duplex: "half", signal: scope.signal } as RequestInit), 2 * 1024 * 1024);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBoundaryError) throw error;
    throw new RequestBoundaryError(503, "processing_store_unavailable", "Owned processing storage is unavailable.");
  } finally { scope.dispose(); }
}

function normalizeSession(raw: unknown): SavedSession {
  const payload = raw as { session?: Record<string, unknown>; events?: Array<Record<string, unknown>>; guidance?: unknown[]; hasMore?: boolean; nextCursor?: number };
  const row = payload.session ?? raw as Record<string, unknown>;
  return { sessionId: String(row.id), status: String(row.status), createdAt: Date.parse(String(row.created_at)),
    hasMore: (payload.events ?? []).length >= 1000 || (payload.guidance ?? []).length >= 500, nextCursor: Number(payload.events?.at(-1)?.pilot_sequence ?? 0),
    events: (payload.events ?? []).map((event) => ({ ...event, sequence: Number(event.pilot_sequence) })), guidance: payload.guidance ?? [] };
}

export const processingRepository = {
  async list(principal: Principal, signal: AbortSignal): Promise<Array<{ sessionId: string; status: string; createdAt: string; updatedAt: string }>> {
    const base = (process.env.PILOT_DATA_API_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!base || !key || !principal.accessToken) throw new RequestBoundaryError(503, "processing_store_unavailable", "Owned session storage is not configured.");
    const scope = processingScope(signal, 8_000);
    try {
      // The authenticated role and RLS remain in force. A verified-owner filter
      // is defense in depth, never a caller-supplied user ID.
      const query = new URLSearchParams({ select: "id,status,created_at,updated_at", user_id: `eq.${principal.userId}`, order: "updated_at.desc", limit: "100" });
      const response = await fetch(`${base}/rest/v1/interview_sessions?${query}`, { headers: { apikey: key, authorization: `Bearer ${principal.accessToken}` }, signal: scope.signal, cache: "no-store" });
      if (!response.ok) throw new Error("Session list unavailable");
      const bytes = await readBoundedBytes(new Request("http://localhost/result", { method: "POST", body: response.body, signal: scope.signal, duplex: "half" } as RequestInit), 65_536);
      const rows: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(rows) || rows.length > 100) throw new Error("Invalid session list");
      return rows.map((row: { id: string; status: string; created_at: string; updated_at: string }) => ({ sessionId: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
    } catch { throw new RequestBoundaryError(503, "processing_store_unavailable", "Saved sessions could not be listed. Retry when the account service is available."); }
    finally { scope.abort(); scope.dispose(); }
  },
  async create(principal: Principal, signal: AbortSignal): Promise<SavedSession> {
    return normalizeSession(await rpc(principal, "pilot_create_session", { p_session_id: crypto.randomUUID(), p_mode: "general", p_consent_version: "visible-user-initiated-v1" }, signal));
  },
  async read(principal: Principal, sessionId: string, after = 0, signal?: AbortSignal): Promise<SavedSession> {
    return normalizeSession(await rpc(principal, "pilot_read_session", { p_session_id: sessionId, p_after_sequence: after }, signal));
  },
  async stop(principal: Principal, sessionId: string, signal: AbortSignal): Promise<unknown> {
    return rpc(principal, "pilot_stop_session", { p_session_id: sessionId }, signal);
  },
  async delete(principal: Principal, sessionId: string, signal: AbortSignal): Promise<unknown> {
    const deleted = await rpc(principal, "pilot_delete_session", { p_session_id: sessionId }, signal);
    if (deleted !== true) throw new RequestBoundaryError(404, "transcript_stream_session_missing", "The session is unavailable.");
    return true;
  },
  async reserve(principal: Principal, input: { sessionId?: string; operationId: string; maxUnits: number; requestHash: string; kind: string }, signal: AbortSignal): Promise<Reservation> {
    // Reject expired settlement configuration before reserving or provider work.
    assertSettlementCredential();
    return await rpc(principal, "pilot_reserve_operation", { p_session_id: input.sessionId ?? null, p_operation_id: input.operationId, p_max_units: input.maxUnits, p_request_hash: input.requestHash, p_kind: input.kind }, signal) as Reservation;
  },
  async complete(principal: Principal, input: { operationId: string; requestHash: string; usedUnits: number; outcome: "succeeded" | "failed" | "unknown"; result: unknown; text?: string; source?: string }): Promise<unknown> {
    // Settlement must continue after browser cancellation. It uses its own bounded
    // deadline, and unknown provider outcomes retain the full reservation.
    return rpc(principal, "pilot_complete_operation", { p_owner_id: principal.userId, p_operation_id: input.operationId, p_request_hash: input.requestHash, p_used_units: input.usedUnits, p_outcome: input.outcome, p_result: input.result, p_transcript_text: input.text ?? null, p_source: input.source ?? "microphone" }, undefined, true);
  },
};
