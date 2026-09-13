import type { ScreenContext } from "./types";

const ERROR_PATTERNS = [
  /\b(error|exception|failed|denied|timeout|not found|unauthorized|forbidden)\b[^\n]*/gi,
  /\bAccessDenied[A-Za-z]*[^\n]*/g,
];

function detectLanguage(text: string): string | null {
  if (/^\s*(\$|#)\s+/m.test(text)) return "Shell";
  if (/\bkubectl\b|\bterraform\b|\bdocker\b|\bgit\b/.test(text)) return "Shell";
  if (/\b(def|import|pytest|Traceback)\b/.test(text)) return "Python";
  if (/\b(function|const|let|interface|type)\b/.test(text)) return /\binterface|type\s+\w+\s*=/.test(text) ? "TypeScript" : "JavaScript";
  if (/\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b.+\bSET\b/i.test(text)) return "SQL";
  if (/\bterraform\b|\bresource\s+"/i.test(text)) return "Terraform";
  if (/\bkubectl\b|\bapiVersion:\b|\bkind:\b/.test(text)) return "Kubernetes/YAML";
  return null;
}

function classifySource(text: string): ScreenContext["sourceType"] {
  if (/\bkubectl\b|\bterraform\b|\bdocker\b|\bgit\b|^\s*(\$|#)\s+/m.test(text)) return "terminal";
  if (/\bAWS\b|\bEC2\b|\bIAM\b|\bCloudWatch\b|\bAzure\b/.test(text)) return "cloud-console";
  if (/\bfunction\b|\bclass\b|\bconst\b|\bdef\b|\bresource\s+"/.test(text)) return "ide";
  if (/\bsequence diagram\b|\bload balancer\b|\bapi gateway\b|\bqueue\b/i.test(text)) return "architecture-diagram";
  if (/\bhttp[s]?:\/\//i.test(text)) return "browser";
  return "unknown";
}

function extractErrorMessages(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of ERROR_PATTERNS) {
    matches.push(...Array.from(text.matchAll(pattern), (match) => match[0].trim()));
  }
  return Array.from(new Set(matches)).slice(0, 8);
}

function extractInfrastructureResources(text: string): string[] {
  const matches = text.match(/\b(aws_[a-z_]+|azurerm_[a-z_]+|kubernetes_[a-z_]+|Deployment|Service|Ingress|VPC|Subnet|IAM Role|Lambda|S3 Bucket)\b/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 12);
}

export function createScreenContextFromText(text: string, timestamp = new Date()): ScreenContext {
  const extractedText = text.trim().slice(0, 4_000);
  const sourceType = classifySource(extractedText);
  const detectedLanguage = detectLanguage(extractedText);
  const errorMessages = extractErrorMessages(extractedText);
  const infrastructureResources = extractInfrastructureResources(extractedText);

  return {
    timestamp: timestamp.toISOString(),
    sourceType,
    extractedText,
    detectedLanguage,
    errorMessages,
    codeSnippet: detectedLanguage ? extractedText.slice(0, 1_500) : null,
    infrastructureResources,
    diagramSummary: sourceType === "architecture-diagram" ? extractedText.slice(0, 500) : null,
    confidence: extractedText.length === 0 ? 0 : sourceType === "unknown" ? 0.45 : 0.78,
  };
}
