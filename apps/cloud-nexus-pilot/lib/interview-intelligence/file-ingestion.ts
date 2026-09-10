import { extractJobProfile, extractResumeProfile } from "./profile-ingestion";

export type ProfileIngestionKind = "resume" | "job-description";

export type ProfileIngestionInput = {
  filename: string;
  contentType: string;
  byteSize: number;
  data: Buffer;
  kind: ProfileIngestionKind;
};

export type ProfileIngestionResult = {
  filename: string;
  contentType: string;
  byteSize: number;
  kind: ProfileIngestionKind;
  extractedText: string;
  resumeProfile: ReturnType<typeof extractResumeProfile> | null;
  jobProfile: ReturnType<typeof extractJobProfile> | null;
};

export const MAX_PROFILE_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_PROFILE_EXTRACTED_CHARS = 60_000;

export function normalizeExtractedProfileText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return normalizeExtractedProfileText(result.text ?? "");
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return normalizeExtractedProfileText(result.value ?? "");
}

export async function extractProfileText(input: {
  filename: string;
  contentType: string;
  byteSize: number;
  data: Buffer;
}): Promise<string> {
  if (input.byteSize > MAX_PROFILE_UPLOAD_BYTES) {
    throw new Error("File is too large. Upload a resume or job description under 6 MB.");
  }

  const contentType = input.contentType.toLowerCase();
  const filename = input.filename.toLowerCase();

  if (contentType.includes("pdf") || filename.endsWith(".pdf")) {
    return extractPdfText(input.data);
  }

  if (
    contentType.includes("wordprocessingml.document") ||
    filename.endsWith(".docx")
  ) {
    return extractDocxText(input.data);
  }

  if (
    contentType.startsWith("text/") ||
    filename.endsWith(".txt") ||
    filename.endsWith(".md")
  ) {
    return normalizeExtractedProfileText(input.data.toString("utf8"));
  }

  throw new Error("Unsupported file type. Upload PDF, DOCX, TXT, or Markdown.");
}

export async function ingestProfileFile(input: ProfileIngestionInput): Promise<ProfileIngestionResult> {
  const extractedText = (await extractProfileText(input)).slice(0, MAX_PROFILE_EXTRACTED_CHARS);
  if (!extractedText) {
    throw new Error("No readable text was extracted from the file.");
  }

  return {
    filename: input.filename,
    contentType: input.contentType || "application/octet-stream",
    byteSize: input.byteSize,
    kind: input.kind,
    extractedText,
    resumeProfile: input.kind === "resume" ? extractResumeProfile(extractedText) : null,
    jobProfile: input.kind === "job-description" ? extractJobProfile(extractedText) : null,
  };
}
