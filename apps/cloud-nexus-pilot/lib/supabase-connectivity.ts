export type SupabaseConnectivityResult = {
  reachable: boolean;
  status: number | null;
  error: string;
  latencyMs: number;
};

type FetchFailure = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
};

function describeFailure(error: unknown, origin: string): string {
  const failure = error && typeof error === "object" ? error as FetchFailure : {};
  const cause = failure.cause && typeof failure.cause === "object"
    ? failure.cause as FetchFailure
    : {};
  const indicators = [failure.code, failure.message, cause.code, cause.message]
    .filter((value): value is string => typeof value === "string");

  if (indicators.some((value) => /\b(?:ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED)\b/.test(value))) {
    return `DNS lookup failed for ${origin}. Project status is unverified; confirm the project reference and status with its owner.`;
  }
  if (failure.name === "TimeoutError" || failure.code === "ETIMEDOUT") {
    return `The connectivity check for ${origin} timed out. Project status is unverified.`;
  }
  if (failure.name === "AbortError") {
    return `The connectivity check for ${origin} was canceled. Project status is unverified.`;
  }

  // Browsers intentionally expose the same fetch error for several failure causes.
  return `No HTTP response was received from ${origin}. Check DNS/network access, browser blocking, and CORS; project status is unverified.`;
}

export async function probeSupabaseConnectivity(
  supabaseUrl: string,
  request: typeof fetch = fetch,
): Promise<SupabaseConnectivityResult> {
  if (!supabaseUrl) {
    return { reachable: false, status: null, error: "Supabase URL not configured", latencyMs: 0 };
  }

  let origin: string;
  try {
    origin = new URL(supabaseUrl).origin;
  } catch {
    return { reachable: false, status: null, error: "Supabase URL is invalid", latencyMs: 0 };
  }

  const start = Date.now();
  try {
    const response = await request(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/health`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    return {
      reachable: response.ok,
      status: response.status,
      error: response.ok ? "" : `HTTP ${response.status}`,
      latencyMs: Math.max(0, Date.now() - start),
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: describeFailure(error, origin),
      latencyMs: Math.max(0, Date.now() - start),
    };
  }
}
