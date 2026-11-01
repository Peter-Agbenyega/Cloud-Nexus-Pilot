// Only application-owned text may cross the provider error boundary.
export const providerLimitErrors = {
  provider_credit_balance_exhausted: { status: 429, message: "OpenAI API credits are exhausted. The app owner must add credits to the connected OpenAI organization before trying again." },
  provider_spend_limit_exceeded: { status: 429, message: "The connected OpenAI account or project has reached its spending limit. The app owner must review that limit before trying again." },
  provider_usage_limit_exceeded: { status: 429, message: "The connected OpenAI organization has reached its API usage limit. The app owner must review its usage limits before trying again." },
  provider_quota_exhausted: { status: 429, message: "OpenAI API quota is unavailable. The app owner must check API credits and usage limits before trying again." },
  provider_rate_limited: { status: 429, message: "OpenAI is temporarily rate limiting requests. Wait before starting another session." },
} as const;

export type ProviderLimitCode = keyof typeof providerLimitErrors;

export class ProviderLimitError extends Error {
  readonly status = 429;
  constructor(readonly code: ProviderLimitCode) {
    super(providerLimitErrors[code].message);
    this.name = "ProviderLimitError";
  }
}

export function isProviderBillingBlock(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && [
    "provider_credit_balance_exhausted", "provider_spend_limit_exceeded",
    "provider_usage_limit_exceeded", "provider_quota_exhausted",
  ].includes(code);
}
