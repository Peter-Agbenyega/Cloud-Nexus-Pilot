import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authorizeProviderUser, providerAuthUnavailable, type ProviderAuthorization } from "./provider-auth-policy";

export async function requireProviderUser(): Promise<ProviderAuthorization> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key || key.startsWith("sb_secret_")) return providerAuthUnavailable();
  try {
    // Never initialize a provider auth client with a privileged service-role key.
    if (key.startsWith("eyJ")) {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as { role?: string };
      if (claims.role !== "anon") return providerAuthUnavailable();
    }
    const cookieStore = await cookies();
    const client = createServerClient(url, key, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (values) => {
          for (const { name, value, options } of values) cookieStore.set(name, value, options);
        },
      },
    });
    return authorizeProviderUser(() => client.auth.getUser());
  } catch {
    return providerAuthUnavailable();
  }
}
