const DEFAULT_RETURN_PATH = "/prompt-library";

/** Accept only paths that remain on this origin after browser URL normalization. */
export function resolveSafeReturnPath(rawNext: string | null): string {
  if (!rawNext || !rawNext.startsWith("/") || rawNext.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(rawNext)) {
    return DEFAULT_RETURN_PATH;
  }
  try {
    const base = "https://pilot.invalid";
    const target = new URL(rawNext, base);
    return target.origin === base
      ? `${target.pathname}${target.search}${target.hash}`
      : DEFAULT_RETURN_PATH;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

const localFallbackPrefixes = ["/workspace", "/transcripts", "/summary", "/prompt-library"];

export function isLocalFallbackPath(pathname: string): boolean {
  return localFallbackPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isProtectedPilotPath(pathname: string): boolean {
  return isLocalFallbackPath(pathname) || pathname === "/billing" || pathname.startsWith("/billing/");
}
