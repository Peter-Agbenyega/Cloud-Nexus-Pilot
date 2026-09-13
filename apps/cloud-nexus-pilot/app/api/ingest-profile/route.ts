import { NextResponse } from "next/server";

import { ingestProfileFile, type ProfileIngestionKind } from "@/lib/interview-intelligence/file-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function kind(value: FormDataEntryValue | null): ProfileIngestionKind {
  return value === "job-description" ? "job-description" : "resume";
}

export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json(
      { error: "invalid_form_data", message: "Upload a PDF, DOCX, TXT, or Markdown file." },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "file_required", message: "A resume or job description file is required." },
      { status: 400 }
    );
  }

  try {
    const result = await ingestProfileFile({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      byteSize: file.size,
      data: Buffer.from(await file.arrayBuffer()),
      kind: kind(formData.get("kind")),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to extract text from the uploaded file.";
    return NextResponse.json(
      {
        error: "ingestion_failed",
        message,
      },
      { status: /too large/i.test(message) ? 413 : /no readable text/i.test(message) ? 422 : 400 }
    );
  }
}
