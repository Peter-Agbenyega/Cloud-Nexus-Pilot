import { ProviderLimitError, type ProviderLimitCode } from "../provider-limits";
import { readBoundedBytes } from "./request-boundary";

// Read a bounded error envelope in memory. Never forward messages, ids, raw
// codes, headers or payloads. Unknown/malformed errors keep the generic fallback.
export async function readOpenAiLimitError(response: Response, signal?: AbortSignal): Promise<ProviderLimitError | null> {
  if (response.status !== 429) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  try {
    const bytes = await readBoundedBytes(new Request("http://localhost/provider-error", {
      method: "POST", body: response.body, signal, duplex: "half",
    } as RequestInit), 16_384);
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
    const error = payload.error;
    if (!error || typeof error !== "object") return null;
    const code = "code" in error ? error.code : undefined;
    const type = "type" in error ? error.type : undefined;
    let safe: ProviderLimitCode | undefined;
    if (code === "credit_balance_exhausted") safe = "provider_credit_balance_exhausted";
    else if (code === "organization_spend_limit_exceeded" || code === "project_spend_limit_exceeded") safe = "provider_spend_limit_exceeded";
    else if (code === "organization_usage_limit_exceeded") safe = "provider_usage_limit_exceeded";
    else if (code === "insufficient_quota" || type === "insufficient_quota") safe = "provider_quota_exhausted";
    else if (code === "rate_limit_exceeded" || code === "slow_down" || type === "rate_limit_error") safe = "provider_rate_limited";
    return safe ? new ProviderLimitError(safe) : null;
  } catch {
    return null;
  }
}
