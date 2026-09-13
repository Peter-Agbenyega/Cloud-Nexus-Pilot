export type DebugArtifactType =
  | "kubectl"
  | "terraform"
  | "aws-cli"
  | "docker"
  | "git"
  | "linux"
  | "ci-cd"
  | "http-network"
  | "generic";

export type DebugRiskLevel = "low" | "medium" | "high";

export type TerminalDebugDiagnosis = {
  artifactType: DebugArtifactType;
  diagnosis: string;
  likelyRootCause: string;
  confidence: number;
  nextCommand: string | null;
  explanation: string;
  riskLevel: DebugRiskLevel;
  dangerousCommand: boolean;
};

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function detectArtifactType(normalized: string): DebugArtifactType {
  if (includesAny(normalized, ["kubectl", "pods is forbidden", "error from server"])) return "kubectl";
  if (
    includesAny(normalized, [
      "terraform",
      "error acquiring the state lock",
      "provider registry",
      " on main.tf ",
      ".tf line",
      "resource \"aws_",
      "resource \"azurerm_",
    ])
  ) return "terraform";
  if (includesAny(normalized, ["aws ", "accessdenied", "access denied", "not authorized to perform"])) return "aws-cli";
  if (includesAny(normalized, ["docker", "container", "imagepullbackoff"])) return "docker";
  if (includesAny(normalized, ["git ", "fatal:", "merge conflict", "rejected", "non-fast-forward"])) return "git";
  if (includesAny(normalized, ["systemctl", "journalctl", "permission denied", "no such file"])) return "linux";
  if (includesAny(normalized, ["github actions", "workflow", "pipeline", "runner", "exit code"])) return "ci-cd";
  if (includesAny(normalized, ["http 5", "http 4", "tls", "dns", "connection refused", "timeout"])) return "http-network";
  return "generic";
}

function containsDangerousCommand(text: string): boolean {
  return /\b(rm\s+-rf|terraform\s+destroy|kubectl\s+delete|drop\s+database|chmod\s+777|docker\s+system\s+prune|git\s+reset\s+--hard)\b/i.test(text);
}

export function diagnoseTerminalArtifact(text: string): TerminalDebugDiagnosis {
  const rawText = text.trim().slice(0, 8_000);
  const normalized = rawText.toLowerCase();
  const artifactType = detectArtifactType(normalized);
  const dangerousCommand = containsDangerousCommand(rawText);

  if (artifactType === "terraform" && includesAny(normalized, ["accessdenied", "access denied", "not authorized"])) {
    return {
      artifactType,
      diagnosis: "Terraform is failing during an AWS API call because the active principal lacks permission.",
      likelyRootCause:
        "The provider role or user is missing the exact IAM action/resource permission, or Terraform is assuming an unexpected role.",
      confidence: 0.88,
      nextCommand: "aws sts get-caller-identity",
      explanation:
        "Confirm the caller identity first, then match the denied action and resource to the least-privilege policy Terraform needs.",
      riskLevel: "medium",
      dangerousCommand,
    };
  }

  if (artifactType === "terraform" && includesAny(normalized, ["state lock", "lock id"])) {
    return {
      artifactType,
      diagnosis: "Terraform cannot acquire its remote state lock.",
      likelyRootCause:
        "Another apply is active, a previous run crashed, or the backend lock record was not released.",
      confidence: 0.84,
      nextCommand: "terraform force-unlock <LOCK_ID>",
      explanation:
        "Only force-unlock after confirming no other apply is running; otherwise state corruption is possible.",
      riskLevel: "high",
      dangerousCommand: true,
    };
  }

  if (artifactType === "kubectl" && includesAny(normalized, ["forbidden", "cannot list", "cannot get", "rbac"])) {
    return {
      artifactType,
      diagnosis: "Kubernetes is rejecting the request through RBAC authorization.",
      likelyRootCause:
        "The current user/service account lacks a RoleBinding or ClusterRoleBinding for the requested resource and namespace.",
      confidence: 0.9,
      nextCommand: "kubectl auth can-i <verb> <resource> --namespace <namespace>",
      explanation:
        "Check the exact verb/resource/namespace authorization before changing bindings, then grant the smallest needed scope.",
      riskLevel: "medium",
      dangerousCommand,
    };
  }

  if (artifactType === "kubectl" && includesAny(normalized, ["crashloopbackoff", "imagepullbackoff", "errimagepull"])) {
    return {
      artifactType,
      diagnosis: "The workload is failing before it reaches a stable running state.",
      likelyRootCause:
        normalized.includes("imagepull")
          ? "The image name, tag, registry auth, or network path is invalid."
          : "The container process is exiting repeatedly due to config, dependency, or runtime errors.",
      confidence: 0.86,
      nextCommand: "kubectl describe pod <pod> --namespace <namespace>",
      explanation:
        "Describe the pod first for events, then inspect logs from the failing container and validate config/env dependencies.",
      riskLevel: "low",
      dangerousCommand,
    };
  }

  if (artifactType === "aws-cli" && includesAny(normalized, ["accessdenied", "not authorized", "explicit deny"])) {
    return {
      artifactType,
      diagnosis: "AWS IAM denied the requested action.",
      likelyRootCause:
        "The identity policy, permission boundary, SCP, session policy, or resource policy blocks the requested action.",
      confidence: 0.89,
      nextCommand: "aws sts get-caller-identity",
      explanation:
        "Identify the caller and denied action, then check for explicit denies before adding narrow allow permissions.",
      riskLevel: "medium",
      dangerousCommand,
    };
  }

  if (artifactType === "docker" && includesAny(normalized, ["cannot connect to the docker daemon", "permission denied"])) {
    return {
      artifactType,
      diagnosis: "Docker client cannot reach or use the daemon.",
      likelyRootCause:
        "The daemon is stopped, the socket is inaccessible, or the user lacks permission for the Docker socket.",
      confidence: 0.83,
      nextCommand: "docker info",
      explanation:
        "Verify daemon reachability, then check the socket permissions or group membership without broadening filesystem access.",
      riskLevel: "low",
      dangerousCommand,
    };
  }

  if (artifactType === "git" && includesAny(normalized, ["non-fast-forward", "rejected", "fetch first"])) {
    return {
      artifactType,
      diagnosis: "Git rejected the push because the remote branch has commits not present locally.",
      likelyRootCause:
        "Someone pushed to the branch, or local history diverged from the remote.",
      confidence: 0.82,
      nextCommand: "git fetch origin",
      explanation:
        "Fetch first, inspect the divergence, and merge or rebase intentionally. Avoid force push unless explicitly approved.",
      riskLevel: "medium",
      dangerousCommand,
    };
  }

  if (artifactType === "http-network" && includesAny(normalized, ["connection refused", "timeout", "dns", "tls"])) {
    return {
      artifactType,
      diagnosis: "The failure is in connectivity, name resolution, or TLS before application logic completes.",
      likelyRootCause:
        "The target service is down, blocked by firewall/security groups, misaddressed in DNS, or presenting invalid TLS.",
      confidence: 0.78,
      nextCommand: "curl -v <url>",
      explanation:
        "Separate DNS, TCP, TLS, and HTTP status so the next fix targets the failing layer.",
      riskLevel: "low",
      dangerousCommand,
    };
  }

  return {
    artifactType,
    diagnosis: "The artifact needs stepwise triage before changing infrastructure.",
    likelyRootCause:
      "The visible output does not contain enough specific provider, resource, or error context for a high-confidence diagnosis.",
    confidence: rawText ? 0.45 : 0.1,
    nextCommand: artifactType === "generic" ? null : "Re-run the command with verbose output or describe/logs.",
    explanation:
      "Start by identifying the failing component, exact error, principal/resource involved, and the safest read-only command.",
    riskLevel: dangerousCommand ? "high" : "low",
    dangerousCommand,
  };
}
