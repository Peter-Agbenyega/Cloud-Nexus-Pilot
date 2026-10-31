/** Keep the explicitly isolated local test stack out of the original session namespace. */
export function pilotAuthCookieOptions(url: string): { name: string } | undefined {
  return process.env.NEXT_PUBLIC_PILOT_TEST_FIXTURE === "1" &&
    url.replace(/\/$/, "") === "http://127.0.0.1:59090"
    ? { name: "sb-pilot-recovery-test-auth-token" }
    : undefined;
}
