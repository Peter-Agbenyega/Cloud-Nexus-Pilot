const DEV_FALLBACK_API_BASE_URL = "http://127.0.0.1:8010";

function getConfiguredApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ?? "";
}

function getBrowserOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function getBrowserHost(): string {
  if (typeof window === "undefined") return "";
  return window.location.hostname;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1";
}

export function getApiBaseUrl(): string {
  const configuredApiBaseUrl = getConfiguredApiBaseUrl();
  const browserHost = getBrowserHost();
  const isLocalBrowserOrigin = isLocalHost(browserHost);
  const isDev = process.env.NODE_ENV === "development";

  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl;
  }

  if (isDev || isLocalBrowserOrigin) {
    return DEV_FALLBACK_API_BASE_URL;
  }

  if (typeof window !== "undefined") {
    console.error(
      "[api-base-url] NEXT_PUBLIC_API_BASE_URL is not set. API calls will fail in production. " +
      "Set this env var in your Vercel project settings."
    );
  }

  return "";
}

export function getApiBaseUrlDiagnostics() {
  const configuredApiBaseUrl = getConfiguredApiBaseUrl();
  const browserOrigin = getBrowserOrigin();
  const browserHost = getBrowserHost();

  return {
    fallbackApiBaseUrl: DEV_FALLBACK_API_BASE_URL,
    configuredApiBaseUrl,
    browserOrigin,
    browserHost,
    resolvedApiBaseUrl: getApiBaseUrl(),
    isConfigured: Boolean(configuredApiBaseUrl),
    isDevelopment: process.env.NODE_ENV === "development",
  };
}
