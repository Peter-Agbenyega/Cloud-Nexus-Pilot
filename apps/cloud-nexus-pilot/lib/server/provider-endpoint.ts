// Only server-controlled configuration chooses an API host. Browser requests
// cannot override it. Plain HTTP is accepted solely for a loopback test service.
export function openAiEndpoint(path: string, configured = process.env.OPENAI_BASE_URL): string {
  const base = new URL(configured?.trim() || "https://api.openai.com/v1");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("Invalid server provider endpoint configuration.");
  }
  return `${base.href.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
