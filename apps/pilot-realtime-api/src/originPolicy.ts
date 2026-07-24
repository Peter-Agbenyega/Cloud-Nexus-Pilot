export type OriginPolicy =
  | {
      allowAnyOrigin: true;
      origins: readonly string[];
    }
  | {
      allowAnyOrigin: false;
      origins: readonly string[];
    };

export function parseOriginPolicy(corsOrigin: string): OriginPolicy {
  const origins = corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    allowAnyOrigin: origins.includes("*"),
    origins: origins.filter((origin) => origin !== "*"),
  };
}

export function getCorsOriginOption(policy: OriginPolicy): true | string[] {
  return policy.allowAnyOrigin ? true : [...policy.origins];
}

export function isWebSocketOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  // Browsers send Origin on WebSocket handshakes. Missing Origin is allowed for trusted
  // non-browser clients that cannot be protected by browser same-origin controls.
  if (origin === undefined) {
    return true;
  }

  if (policy.allowAnyOrigin) {
    return true;
  }

  return policy.origins.includes(origin);
}
