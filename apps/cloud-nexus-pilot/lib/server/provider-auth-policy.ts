type VerifiedUser = { id: string; role?: string; is_anonymous?: boolean };
type UserLookup = () => Promise<{ data: { user: VerifiedUser | null }; error: unknown }>;

export type ProviderAuthorization =
  | { userId: string; response?: never }
  | { userId?: never; response: Response };

export function providerAuthUnavailable(): ProviderAuthorization {
  return { response: Response.json({ error: { code: "provider_auth_unavailable", message: "Provider features require configured account authentication. Local tools remain available." } }, { status: 503 }) };
}

// Only a verified ordinary account may spend server-side provider credentials.
// The lookup must validate with Supabase Auth, never trust cookie contents/getSession().
export async function authorizeProviderUser(getUser: UserLookup): Promise<ProviderAuthorization> {
  try {
    const { data, error } = await getUser();
    if (error || !data.user) {
      return { response: Response.json({ error: { code: "authentication_required", message: "Sign in to use provider features." } }, { status: 401 }) };
    }
    if (!data.user.id || data.user.role !== "authenticated" || data.user.is_anonymous) {
      return { response: Response.json({ error: { code: "ordinary_account_required", message: "An ordinary signed-in account is required for provider features." } }, { status: 403 }) };
    }
    return { userId: data.user.id };
  } catch {
    return providerAuthUnavailable();
  }
}
