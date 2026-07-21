export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type AttachmentLike = { name: string; size: number; type?: string };

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "csv", "txt", "md", "log", "json", "xml", "rtf",
  "png", "jpg", "jpeg", "gif", "webp",
]);

const ACTIVE_OR_EXECUTABLE_MIME_TYPES = /^(?:text\/html|application\/(?:xhtml\+xml|javascript|x-javascript|x-msdownload|x-msdos-program|x-sh|x-csh)|text\/(?:javascript|x-shellscript)|image\/svg\+xml)$/i;

const SAFE_INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function sanitizeAttachmentName(name: string): string {
  const normalized = name
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^[._]+/, "")
    .trim();
  return normalized.slice(0, 180) || "document";
}

export function validateChatAttachments(files: AttachmentLike[]): string | null {
  if (files.length > MAX_CHAT_ATTACHMENTS) {
    return `You can attach up to ${MAX_CHAT_ATTACHMENTS} documents at once.`;
  }
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      return `“${sanitizeAttachmentName(file.name)}” is over the 25 MB document limit.`;
    }
    const extension = sanitizeAttachmentName(file.name).split(".").pop()?.toLowerCase() || "";
    const mimeType = String(file.type || "").trim().toLowerCase();
    if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension) || ACTIVE_OR_EXECUTABLE_MIME_TYPES.test(mimeType)) {
      return `“${sanitizeAttachmentName(file.name)}” is not a supported document or image type.`;
    }
  }
  return null;
}

export function attachmentContentDisposition(mimeType: string, fileName: string): string {
  const disposition = SAFE_INLINE_MIME_TYPES.has(String(mimeType || "").toLowerCase())
    ? "inline" : "attachment";
  const safeName = sanitizeAttachmentName(fileName).replace(/"/g, "");
  return `${disposition}; filename="${safeName}"`;
}

export function attachmentResponseHeaders(mimeType: string, fileName: string): Record<string, string> {
  return {
    "Content-Type": mimeType,
    "Content-Disposition": attachmentContentDisposition(mimeType, fileName),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

export function inferAttachmentMimeType(mimeType: string, fileName: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const extension = fileName.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    log: "text/plain",
    json: "application/json",
    xml: "application/xml",
    rtf: "application/rtf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return (extension && byExtension[extension]) || "application/octet-stream";
}
