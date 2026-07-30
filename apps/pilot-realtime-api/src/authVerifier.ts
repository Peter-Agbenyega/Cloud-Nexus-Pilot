import { createClient } from "@supabase/supabase-js";

export type VerifiedAuthToken = {
  userId: string;
  expiresAtEpochSeconds: number;
};

export type AuthVerifier = {
  verifyAccessToken: (accessToken: string, signal: AbortSignal) => Promise<VerifiedAuthToken>;
};

export type SupabaseAuthVerifierConfig = {
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_URL: string;
};

type SupabaseClaims = {
  aud?: unknown;
  exp?: unknown;
  is_anonymous?: unknown;
  iss?: unknown;
  role?: unknown;
  sub?: unknown;
};

const SUPABASE_AUTHENTICATED_AUDIENCE = "authenticated";
const AUTH_EXPIRATION_ACCEPTANCE_CLOCK_SKEW_SECONDS = 0;

export class AuthVerificationError extends Error {
  constructor(readonly category: string) {
    super("Authentication failed");
  }
}

function expectedIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

function reject(category: string): never {
  throw new AuthVerificationError(category);
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const uniqueSignals = Array.from(new Set(signals));
  if (uniqueSignals.length === 1) {
    return uniqueSignals[0]!;
  }

  // The realtime API targets Node 22, where AbortSignal.any() is native.
  return AbortSignal.any(uniqueSignals);
}

function requestSignal(input: RequestInfo | URL): AbortSignal | undefined {
  return typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
}

export function createSignalAwareFetch(attemptSignal: AbortSignal, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const signals = [attemptSignal, init?.signal, requestSignal(input)].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const signal = combineAbortSignals(signals);

    try {
      return await baseFetch(input, {
        ...init,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        return new Response(JSON.stringify({ message: "Authentication failed" }), {
          headers: { "content-type": "application/json" },
          status: 499,
        });
      }

      throw error;
    }
  };
}

function hasAuthenticatedAudience(audience: unknown): boolean {
  if (typeof audience === "string") {
    return audience === SUPABASE_AUTHENTICATED_AUDIENCE;
  }

  if (Array.isArray(audience)) {
    return audience.some((entry) => entry === SUPABASE_AUTHENTICATED_AUDIENCE);
  }

  return false;
}

export function validateSupabaseClaims(claims: SupabaseClaims, env: SupabaseAuthVerifierConfig): VerifiedAuthToken {
  const userId = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (userId.length === 0) {
    reject("missing_sub");
  }

  // Supabase auth-js getClaims() rejects expired JWTs unless allowExpired is
  // explicitly enabled. Keep this independent check fail-closed too: no positive
  // clock skew is applied here, so tokens at or before exp are not accepted.
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  if (
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowEpochSeconds + AUTH_EXPIRATION_ACCEPTANCE_CLOCK_SKEW_SECONDS
  ) {
    reject("expired");
  }

  if (claims.iss !== expectedIssuer(env.SUPABASE_URL)) {
    reject("wrong_issuer");
  }

  if (claims.is_anonymous === true) {
    reject("anonymous");
  }

  const role = typeof claims.role === "string" ? claims.role : "";
  if (role !== "authenticated" || !hasAuthenticatedAudience(claims.aud)) {
    reject("unauthenticated_role");
  }

  return {
    userId,
    expiresAtEpochSeconds: claims.exp,
  };
}

export function createSupabaseAuthVerifier(env: SupabaseAuthVerifierConfig): AuthVerifier {
  return {
    async verifyAccessToken(accessToken: string, signal: AbortSignal): Promise<VerifiedAuthToken> {
      if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
        reject("missing_token");
      }

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          fetch: createSignalAwareFetch(signal),
        },
      });

      const { data, error } = await supabase.auth.getClaims(accessToken);
      if (error !== null || data === null) {
        reject("unverifiable");
      }

      return validateSupabaseClaims(data.claims, env);
    },
  };
}
