import { createClient } from "@supabase/supabase-js";

const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const rawSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const expectedCloudNexusSupabaseUrl = "https://wwhxaligcyqpnpdfxynr.supabase.co";

function isPlaceholderSupabaseUrl(value: string): boolean {
  return /your-project-ref/i.test(value) || /example\.supabase\.co/i.test(value);
}

function isPlaceholderAnonKey(value: string): boolean {
  return /your_supabase_anon_key/i.test(value) || /your-anon-key/i.test(value);
}

function looksLikeValidAnonKey(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  if (value.startsWith("eyJ")) return true;
  if (value.startsWith("sb_publishable_")) return true;
  return value.length >= 20;
}

const missingEnvVars = [
  !rawSupabaseUrl ? "NEXT_PUBLIC_SUPABASE_URL" : "",
  !rawSupabaseAnonKey ? "NEXT_PUBLIC_SUPABASE_ANON_KEY" : "",
].filter(Boolean);

const hasPlaceholderSupabaseUrl =
  Boolean(rawSupabaseUrl) && isPlaceholderSupabaseUrl(rawSupabaseUrl);
const hasPlaceholderAnonKey =
  Boolean(rawSupabaseAnonKey) && isPlaceholderAnonKey(rawSupabaseAnonKey);

let parsedSupabaseUrl: URL | null = null;
if (rawSupabaseUrl && !hasPlaceholderSupabaseUrl) {
  try {
    parsedSupabaseUrl = new URL(rawSupabaseUrl);
  } catch {
    parsedSupabaseUrl = null;
  }
}

const hasValidSupabaseUrl =
  Boolean(parsedSupabaseUrl) &&
  Boolean(parsedSupabaseUrl?.hostname?.endsWith(".supabase.co"));
const matchesExpectedCloudNexusProject =
  !parsedSupabaseUrl ||
  rawSupabaseUrl.replace(/\/+$/, "") === expectedCloudNexusSupabaseUrl;
const hasValidAnonKey =
  Boolean(rawSupabaseAnonKey) &&
  !hasPlaceholderAnonKey &&
  looksLikeValidAnonKey(rawSupabaseAnonKey);

const supabaseUrl = hasValidSupabaseUrl ? rawSupabaseUrl.replace(/\/+$/, "") : "";
const supabaseAnonKey = hasValidAnonKey ? rawSupabaseAnonKey : "";
const supabaseSignupEndpoint = supabaseUrl ? `${supabaseUrl}/auth/v1/signup` : "";
const supabaseSigninEndpoint = supabaseUrl
  ? `${supabaseUrl}/auth/v1/token?grant_type=password`
  : "";

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      })
    : null;

export const supabaseConfigError = (() => {
  if (missingEnvVars.length > 0) {
    return `Supabase env vars missing: ${missingEnvVars.join(", ")}. Set them in your frontend environment before enabling auth or cloud sync.`;
  }
  if (hasPlaceholderSupabaseUrl || hasPlaceholderAnonKey) {
    return "Supabase env vars still use placeholder values. Replace NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY with real project values.";
  }
  if (!parsedSupabaseUrl) {
    return "Supabase URL is invalid. Use: https://<project-ref>.supabase.co";
  }
  if (!hasValidSupabaseUrl) {
    return "Supabase URL host is invalid. It must end with .supabase.co";
  }
  if (!matchesExpectedCloudNexusProject) {
    return `Supabase URL points to ${parsedSupabaseUrl?.origin ?? "an unknown project"}, but Cloud Nexus Pilot expects ${expectedCloudNexusSupabaseUrl}. Update NEXT_PUBLIC_SUPABASE_URL in Vercel and redeploy.`;
  }
  if (!hasValidAnonKey) {
    return "Supabase anon key format is invalid. Set NEXT_PUBLIC_SUPABASE_ANON_KEY to a valid Supabase anon or publishable key.";
  }
  return "";
})();

export const supabaseConfigDiagnostics = {
  missingEnvVars,
  hasPlaceholderSupabaseUrl,
  hasPlaceholderAnonKey,
  hasRawUrl: Boolean(rawSupabaseUrl),
  hasRawAnonKey: Boolean(rawSupabaseAnonKey),
  hasUrl: Boolean(supabaseUrl),
  hasAnonKey: Boolean(supabaseAnonKey),
  urlIsValid: Boolean(parsedSupabaseUrl),
  urlHostMatchesSupabase: hasValidSupabaseUrl,
  matchesExpectedCloudNexusProject,
  expectedOrigin: expectedCloudNexusSupabaseUrl,
  anonKeyLooksValid: hasValidAnonKey,
  origin: parsedSupabaseUrl?.origin ?? "",
  authSignupEndpoint: supabaseSignupEndpoint,
  authSigninEndpoint: supabaseSigninEndpoint,
};

export async function checkSupabaseConnectivity(): Promise<{
  reachable: boolean;
  status: number | null;
  error: string;
  latencyMs: number;
}> {
  if (!supabaseUrl) {
    return { reachable: false, status: null, error: "Supabase URL not configured", latencyMs: 0 };
  }

  const start = Date.now();
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Date.now() - start;
    return {
      reachable: response.ok,
      status: response.status,
      error: response.ok ? "" : `HTTP ${response.status}`,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    const isDns = /ENOTFOUND|ERR_NAME_NOT_RESOLVED|Failed to fetch/i.test(message);
    return {
      reachable: false,
      status: null,
      error: isDns
        ? `DNS resolution failed for ${supabaseUrl}. The Supabase project may be paused, deleted, or the project ref is incorrect.`
        : message,
      latencyMs,
    };
  }
}

type SupabaseAuthErrorLike = {
  message?: string;
  status?: number;
  code?: string;
  name?: string;
};

export function getSupabaseAuthErrorMessage(
  error: unknown,
  action: "signin" | "signup" | "reset-password" | "resend-confirmation" = "signup"
): string {
  const errorLike = (error ?? {}) as SupabaseAuthErrorLike;
  const message = typeof errorLike.message === "string" ? errorLike.message : "";
  const status = typeof errorLike.status === "number" ? errorLike.status : null;
  const code = typeof errorLike.code === "string" ? errorLike.code : "";
  const name = typeof errorLike.name === "string" ? errorLike.name : "UnknownError";
  const actionLabel =
    action === "signin"
      ? "Sign in"
      : action === "signup"
        ? "Signup"
        : action === "reset-password"
          ? "Password reset"
          : "Resend confirmation";
  const endpointForAction =
    action === "signin"
      ? supabaseSigninEndpoint
      : action === "signup"
        ? supabaseSignupEndpoint
        : supabaseUrl
          ? `${supabaseUrl}/auth/v1/recover`
          : "";

  if (typeof window !== "undefined") {
    console.error("Supabase auth request failed", {
      name,
      status,
      code,
      message,
      authEndpoint: endpointForAction,
      supabaseOrigin: parsedSupabaseUrl?.origin ?? "",
    });
  }

  if (message) {
    if (/invalid login credentials/i.test(message) || /invalid credentials/i.test(message)) {
      return "Invalid email or password. Check your credentials and try again.";
    }

    if (
      /email not confirmed/i.test(message) ||
      /email not verified/i.test(message) ||
      code === "email_not_confirmed"
    ) {
      return "Your email is not confirmed yet. Confirm your email, or resend confirmation.";
    }

    if (
      /user already registered/i.test(message) ||
      /already been registered/i.test(message) ||
      code === "user_already_exists"
    ) {
      return "An account with this email already exists. Try signing in instead.";
    }

    const isFetchFailure = /failed to fetch/i.test(message);
    if (isFetchFailure) {
      const offlineHint =
        typeof navigator !== "undefined" && navigator.onLine === false
          ? " Browser reports offline mode."
          : "";
      const mixedContentHint =
        typeof window !== "undefined" &&
        window.location.protocol === "https:" &&
        parsedSupabaseUrl?.protocol === "http:"
          ? " Mixed-content detected: NEXT_PUBLIC_SUPABASE_URL must use https in production."
          : "";
      const endpointHint = endpointForAction
        ? ` Network call to ${endpointForAction} failed before receiving a response.`
        : "";

      return (
        `${actionLabel} request could not reach Supabase.` +
        endpointHint +
        " Check NEXT_PUBLIC_SUPABASE_URL project ref, DNS or network access, browser extensions or firewall, and deployment env configuration." +
        offlineHint +
        mixedContentHint
      );
    }

    if (status) {
      return `${actionLabel} failed (status ${status}). ${message}`;
    }
    if (code) {
      return `${actionLabel} failed (${code}). ${message}`;
    }

    return message;
  }

  return "Authentication failed due to an unknown error.";
}
