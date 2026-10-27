import { processingScope, withAbort, readBoundedBytes } from "./lib/server/request-boundary";
import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr/dist/module/createServerClient";

import { isLocalFallbackPath, isProtectedPilotPath } from "./lib/auth-return-path";

export async function middleware(request: NextRequest) {
  if (!isProtectedPilotPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isLocalFallbackPath(request.nextUrl.pathname)) return NextResponse.next();
    console.error("[middleware] Supabase env vars missing; denying protected route access.");

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/auth/login";
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );

    return NextResponse.redirect(loginUrl);
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const authScope = processingScope(request.signal, 8_000);
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    global: { fetch: async (input, init) => {
      const upstream = await fetch(input, { ...init, signal: authScope.signal });
      const bytes = await readBoundedBytes(new Request("http://localhost/auth-reply", { method: "POST", body: upstream.body, signal: authScope.signal, duplex: "half" } as RequestInit), 262_144);
      return new Response(bytes, { status: upstream.status, headers: upstream.headers });
    } },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({
          request: {
            headers: request.headers,
          },
        });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data: { user }, error } = await withAbort(supabase.auth.getUser(), authScope.signal)
    .catch(() => ({ data: { user: null }, error: { message: "Identity verification unavailable." } }))
    .finally(() => { authScope.abort(); authScope.dispose(); });

  if (error) {
    console.error("[middleware] Identity verification failed; denying protected route access.");

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/auth/login";
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );

    return NextResponse.redirect(loginUrl);
  }

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/auth/login";
    loginUrl.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`
    );
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/workspace/:path*",
    "/transcripts/:path*",
    "/summary/:path*",
    "/prompt-library/:path*",
    "/billing/:path*",
  ],
};
