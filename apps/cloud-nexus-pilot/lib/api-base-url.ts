const FALLBACK_API_BASE_URL = "http://127.0.0.1:8010";

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
  const browserOrigin = getBrowserOrigin();
  const browserHost = getBrowserHost();
  const isLocalBrowserOrigin = isLocalHost(browserHost);

  if (!configuredApiBaseUrl) return FALLBACK_API_BASE_URL;

  if (process.env.NODE_ENV !== "development" && isLocalBrowserOrigin && browserOrigin) {
    return browserOrigin;
  }

  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") {
    return configuredApiBaseUrl;
  }

  if (!isLocalBrowserOrigin) return configuredApiBaseUrl;

  try {
    const apiUrl = new URL(configuredApiBaseUrl);
    const isLocalApi = isLocalHost(apiUrl.hostname);
    return isLocalApi ? configuredApiBaseUrl : FALLBACK_API_BASE_URL;
  } catch {
    return FALLBACK_API_BASE_URL;
  }
}

export function getApiBaseUrlDiagnostics() {
  const configuredApiBaseUrl = getConfiguredApiBaseUrl();
  const browserOrigin = getBrowserOrigin();
  const browserHost = getBrowserHost();

  return {
    fallbackApiBaseUrl: FALLBACK_API_BASE_URL,
    configuredApiBaseUrl,
    browserOrigin,
    browserHost,
    resolvedApiBaseUrl: getApiBaseUrl(),
    isConfigured: Boolean(configuredApiBaseUrl),
    isDevelopment: process.env.NODE_ENV === "development",
  };
}
