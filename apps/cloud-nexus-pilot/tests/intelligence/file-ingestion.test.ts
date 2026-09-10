import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractProfileText,
  ingestProfileFile,
  MAX_PROFILE_UPLOAD_BYTES,
} from "../../lib/interview-intelligence/file-ingestion";

test("ingests a plain text resume and extracts structured profile data", async () => {
  const result = await ingestProfileFile({
    filename: "resume.txt",
    contentType: "text/plain",
    byteSize: 128,
    data: Buffer.from(`
      Senior DevOps Engineer
      AWS Certified Solutions Architect
      Automated Terraform modules and reduced incidents by 40%.
      Led IAM least privilege remediation.
    `),
    kind: "resume",
  });

  assert.equal(result.kind, "resume");
  assert.match(result.extractedText, /Senior DevOps Engineer/);
  assert.ok(result.resumeProfile?.certifications.some((item) => /AWS Certified/i.test(item)));
  assert.ok(result.resumeProfile?.technologies.includes("terraform"));
  assert.equal(result.jobProfile, null);
});

test("ingests markdown job descriptions and extracts job profile data", async () => {
  const result = await ingestProfileFile({
    filename: "job.md",
    contentType: "text/markdown",
    byteSize: 128,
    data: Buffer.from(`
      ## Senior Platform Engineer
      Required: AWS, Kubernetes, Terraform, CI/CD, IAM.
      Preferred: DevSecOps and OWASP experience.
      Responsibilities include designing secure cloud platforms.
    `),
    kind: "job-description",
  });

  assert.equal(result.kind, "job-description");
  assert.equal(result.resumeProfile, null);
  assert.ok(result.jobProfile?.keywords.includes("kubernetes"));
  assert.ok(result.jobProfile?.likelyInterviewTopics.length);
});

test("rejects oversized profile uploads before parsing", async () => {
  await assert.rejects(
    () =>
      extractProfileText({
        filename: "resume.txt",
        contentType: "text/plain",
        byteSize: MAX_PROFILE_UPLOAD_BYTES + 1,
        data: Buffer.from("too large"),
      }),
    /too large/i
  );
});

test("rejects unsupported profile file types", async () => {
  await assert.rejects(
    () =>
      extractProfileText({
        filename: "resume.exe",
        contentType: "application/octet-stream",
        byteSize: 128,
        data: Buffer.from("not a profile document"),
      }),
    /unsupported/i
  );
});
