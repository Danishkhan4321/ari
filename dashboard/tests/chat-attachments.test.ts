import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  attachmentContentDisposition,
  attachmentResponseHeaders,
  inferAttachmentMimeType,
  sanitizeAttachmentName,
  validateChatAttachments,
} from "../lib/chat-attachments";

test("accepts standard local document metadata", () => {
  assert.equal(validateChatAttachments([{ name: "Quarterly plan.pdf", size: 2_400 }]), null);
});

test("rejects more than the supported attachment count", () => {
  const files = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, (_, index) => ({ name: `file-${index}.txt`, size: 1 }));
  assert.match(validateChatAttachments(files) || "", /up to/i);
});

test("rejects oversized documents before upload", () => {
  assert.match(
    validateChatAttachments([{ name: "archive.pdf", size: MAX_CHAT_ATTACHMENT_BYTES + 1 }]) || "",
    /25 MB/i,
  );
});

test("normalizes filenames before local staging", () => {
  assert.equal(sanitizeAttachmentName("..\\private/plan\u0000.pdf"), "private_plan.pdf");
});

test("infers a safe document MIME type when Windows does not provide one", () => {
  assert.equal(inferAttachmentMimeType("", "meeting-notes.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(inferAttachmentMimeType("", "summary.md"), "text/markdown");
});

test("rejects active and executable attachment formats", () => {
  for (const file of [
    { name: "payload.html", size: 100, type: "text/html" },
    { name: "diagram.svg", size: 100, type: "image/svg+xml" },
    { name: "installer.exe", size: 100, type: "application/x-msdownload" },
    { name: "renamed.pdf", size: 100, type: "text/html" },
  ]) {
    assert.match(validateChatAttachments([file]) || "", /not a supported/i, file.name);
  }
});

test("only inert preview formats are served inline", () => {
  assert.match(attachmentContentDisposition("application/pdf", "plan.pdf"), /^inline;/);
  assert.match(attachmentContentDisposition("image/png", "chart.png"), /^inline;/);
  assert.match(attachmentContentDisposition("text/html", "payload.html"), /^attachment;/);
  assert.match(attachmentContentDisposition("image/svg+xml", "diagram.svg"), /^attachment;/);
  assert.match(attachmentContentDisposition("application/vnd.ms-excel", "report.xls"), /^attachment;/);
  const activeHeaders = attachmentResponseHeaders("text/html", "payload.html");
  assert.match(activeHeaders["Content-Disposition"], /^attachment;/);
  assert.equal(activeHeaders["X-Content-Type-Options"], "nosniff");
});
