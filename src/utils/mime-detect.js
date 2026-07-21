/**
 * Magic-byte MIME detection for uploaded files.
 *
 * Until May 19 2026 the bot trusted whatever MIME type WhatsApp's
 * client claimed, plus a filename-extension check. A malicious user
 * could upload a polyglot file labeled `.pdf` and reach pdf-parse,
 * or a `.csv` that is actually a zip bomb. We now sniff the first
 * 32 bytes for known magic numbers and reject mismatches.
 *
 * Returns:
 *   { ok: true,  detected: 'pdf'|'png'|'jpeg'|'mp4'|'csv'|... }
 *   { ok: false, reason: 'mismatch'|'unknown'|'empty' }
 *
 * The detection table is intentionally short — adding signatures is
 * cheap, false positives are dangerous. Unknown types are rejected by
 * default; pass `allowUnknown: true` to opt into loose mode.
 */

// (magic-prefix, label) pairs. Order matters: more-specific prefixes
// (e.g., 'matroska/webm') should come before broader ones. We test by
// `buf.indexOf(prefix, start) === start`.
const MAGIC = [
  // PDF
  { bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]), label: 'pdf' }, // %PDF
  // PNG
  { bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), label: 'png' },
  // JPEG (any flavor)
  { bytes: Buffer.from([0xFF, 0xD8, 0xFF]), label: 'jpeg' },
  // GIF87a / GIF89a
  { bytes: Buffer.from([0x47, 0x49, 0x46, 0x38]), label: 'gif' },
  // WebP — RIFF....WEBP
  { bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]), tail: Buffer.from([0x57, 0x45, 0x42, 0x50]), tailOffset: 8, label: 'webp' },
  // MP4 / MOV — ftyp box at offset 4
  { bytes: Buffer.from([0x66, 0x74, 0x79, 0x70]), offset: 4, label: 'mp4' },
  // Matroska / WebM
  { bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), label: 'matroska' },
  // OGG
  { bytes: Buffer.from([0x4F, 0x67, 0x67, 0x53]), label: 'ogg' },
  // MP3 with ID3
  { bytes: Buffer.from([0x49, 0x44, 0x33]), label: 'mp3' },
  // MP3 without ID3 (MPEG frame sync)
  { bytes: Buffer.from([0xFF, 0xFB]), label: 'mp3' },
  { bytes: Buffer.from([0xFF, 0xF3]), label: 'mp3' },
  { bytes: Buffer.from([0xFF, 0xF2]), label: 'mp3' },
  // M4A / AAC in MP4 container — same ftyp signature with brand 'M4A '
  { bytes: Buffer.from([0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41]), offset: 4, label: 'm4a' },
  // WAV — RIFF....WAVE
  { bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]), tail: Buffer.from([0x57, 0x41, 0x56, 0x45]), tailOffset: 8, label: 'wav' },
  // ZIP (also docx/xlsx/pptx — modern Office is zip)
  { bytes: Buffer.from([0x50, 0x4B, 0x03, 0x04]), label: 'zip' },
  { bytes: Buffer.from([0x50, 0x4B, 0x05, 0x06]), label: 'zip-empty' },
  // Old-format Word/Excel
  { bytes: Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), label: 'ole2' },
];

/**
 * Detect the file type from the first N bytes of a buffer.
 * @param {Buffer} buf
 * @returns {string|null} label or null if unrecognized
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  for (const m of MAGIC) {
    const off = m.offset || 0;
    if (buf.length < off + m.bytes.length) continue;
    let match = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (buf[off + i] !== m.bytes[i]) { match = false; break; }
    }
    if (!match) continue;
    if (m.tail) {
      if (buf.length < m.tailOffset + m.tail.length) continue;
      let tailMatch = true;
      for (let i = 0; i < m.tail.length; i++) {
        if (buf[m.tailOffset + i] !== m.tail[i]) { tailMatch = false; break; }
      }
      if (!tailMatch) continue;
    }
    return m.label;
  }
  // CSV / plain text — sniff for printable ASCII in first 256 bytes.
  // CSV detection is heuristic; we just need to confirm it's not binary.
  const head = buf.slice(0, Math.min(buf.length, 256));
  let printable = 0;
  for (const b of head) {
    if (b === 0x09 || b === 0x0A || b === 0x0D || (b >= 0x20 && b <= 0x7E)) printable++;
  }
  if (printable / head.length > 0.95) return 'text';
  return null;
}

/**
 * Validate that the detected magic matches the claimed MIME family.
 * Returns { ok, detected, reason? }
 */
function validate(buf, claimedMime, opts = {}) {
  if (!buf || buf.length === 0) return { ok: false, reason: 'empty' };
  const detected = sniff(buf);
  if (!detected) {
    return opts.allowUnknown
      ? { ok: true, detected: 'unknown' }
      : { ok: false, reason: 'unknown' };
  }
  if (!claimedMime) return { ok: true, detected };
  const claim = claimedMime.toLowerCase();
  // Lenient mapping — accept if detected fits into the broad MIME family
  const allowedMap = {
    pdf: ['application/pdf'],
    png: ['image/png'],
    jpeg: ['image/jpeg', 'image/jpg'],
    gif: ['image/gif'],
    webp: ['image/webp'],
    mp4: ['video/mp4', 'audio/mp4', 'video/quicktime'],
    matroska: ['video/x-matroska', 'video/webm', 'audio/webm'],
    ogg: ['audio/ogg', 'video/ogg', 'application/ogg'],
    mp3: ['audio/mpeg', 'audio/mp3'],
    m4a: ['audio/mp4', 'audio/m4a', 'audio/x-m4a'],
    wav: ['audio/wav', 'audio/x-wav', 'audio/wave'],
    zip: ['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
          'application/vnd.oasis.opendocument.presentation'],
    ole2: ['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
           'application/x-tika-msoffice'],
    text: ['text/plain', 'text/csv', 'text/markdown', 'text/html', 'application/csv', 'application/json',
           'application/xml', 'application/rtf', 'application/vnd.ms-excel'],
  };
  const allowed = allowedMap[detected] || [];
  if (allowed.some(m => claim === m || claim.startsWith(m + ';'))) {
    return { ok: true, detected };
  }
  return { ok: false, reason: 'mismatch', detected };
}

module.exports = { sniff, validate };
