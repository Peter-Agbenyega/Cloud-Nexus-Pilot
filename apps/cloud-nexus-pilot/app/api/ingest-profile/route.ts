import { requireProviderUser } from "@/lib/server/provider-auth";
import { acquireIngress } from "@/lib/server/ingress-admission";
import { assertSameOrigin, boundaryResponse, readBoundedBytes } from "@/lib/server/request-boundary";
import { NextResponse } from "next/server";

import { ingestProfileFile, type ProfileIngestionKind } from "@/lib/interview-intelligence/file-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function kind(value: FormDataEntryValue | null): ProfileIngestionKind {
  return value === "job-description" ? "job-description" : "resume";
}

export async function POST(request: Request) {
  const auth = await requireProviderUser(request);
  if (auth.response) return auth.response;
  let release: (() => void) | undefined;
  try {
    release = acquireIngress(auth.userId);
  let formData: FormData | null;
  try {
    assertSameOrigin(request);
    const bytes = await readBoundedBytes(request, 4 * 1024 * 1024);
    formData = await new Request(request.url, { method: "POST", headers: { "content-type": request.headers.get("content-type") || "" }, body: bytes }).formData();
  } catch (error) { return boundaryResponse(error); }
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
  } catch {
    const message = "Unable to extract this file. Use a supported PDF, DOCX or plain-text document within the upload limit.";
    return NextResponse.json(
      {
        error: "ingestion_failed",
        message,
      },
      { status: /too large/i.test(message) ? 413 : /no readable text/i.test(message) ? 422 : 400 }
    );
  }
  } catch (error) { return boundaryResponse(error); }
  finally { release?.(); }

}
