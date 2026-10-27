import { processingScope, withAbort } from "./request-boundary";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authorizeProviderUser, providerAuthUnavailable, type ProviderAuthorization } from "./provider-auth-policy";

export async function requireProviderUser(request?: Request): Promise<ProviderAuthorization> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key || key.startsWith("sb_secret_")) return providerAuthUnavailable();
  const scope = processingScope(request?.signal ?? new AbortController().signal, 8_000);
  try {
    // Never initialize a provider auth client with a privileged service-role key.
    if (key.startsWith("eyJ")) {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as { role?: string };
      if (claims.role !== "anon") return providerAuthUnavailable();
    }
    const cookieStore = await cookies();
    const client = createServerClient(url, key, {
      global: { fetch: (input, init) => fetch(input, { ...init, signal: scope.signal }) },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (values) => {
          for (const { name, value, options } of values) cookieStore.set(name, value, options);
        },
      },
    });
    const verified = await authorizeProviderUser(() => withAbort(client.auth.getUser(), scope.signal));
    if (verified.response) return verified;
    // getSession is used only to transport the credential AFTER getUser verified
    // the principal; it never supplies the identity or authorization decision.
    const { data } = await withAbort(client.auth.getSession(), scope.signal);
    if (!data.session || data.session.user.id !== verified.userId) return providerAuthUnavailable();
    return { ...verified, accessToken: data.session.access_token };
  } catch {
    return providerAuthUnavailable();
  } finally { scope.abort(); scope.dispose(); }
}
