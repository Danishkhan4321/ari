/**
 * Text & security utility tests (offline — no network, no DB, no WhatsApp).
 *
 * Covers seven pure utility modules that previously had no coverage:
 *   1. mime-detect        — magic-byte sniffing + claimed-MIME validation
 *                           (SECURITY control: rejects mislabeled uploads).
 *   2. whatsapp-format    — GPT Markdown → WhatsApp formatting conversion.
 *   3. llm-output-validator — context-bleed heuristic: is LLM output
 *                           plausibly derived from the user's CURRENT turn?
 *   4. history-sanitizer  — strips "Example:/Try:" hint lines from assistant
 *                           history before it is fed back to the LLM.
 *   5. history-session-filter — trims conversation history to the current
 *                           session at the first large inter-message gap.
 *   6. whatsapp-24h       — sanitizeTemplateParam only (Meta template-param
 *                           rules: no newlines/tabs, <=4 consecutive spaces).
 *   7. format-phone       — maskPhone privacy masking.
 *
 * Run: node --test tests/text-security-utils.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Stub heavy dependencies via require cache ────
// whatsapp-24h.js requires the DB pool, messaging service, and WhatsApp
// adapter at load time. We only test its pure sanitizeTemplateParam export,
// so stub all three before the module is required.
function stubModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
    children: [],
    parent: null,
    paths: [],
  };
  return exportsObj;
}

stubModule('../src/config/database', {
  query: async () => ({ rows: [], rowCount: 0 }),
  pool: null,
});
stubModule('../src/services/messaging.service', { send: async () => {} });
stubModule('../src/adapters/whatsapp.adapter', { sendTemplate: async () => {} });

// ── Modules under test ─────────────────────────────────────────────────────
const { sniff, validate } = require('../src/utils/mime-detect');
const { markdownToWhatsApp, WHATSAPP_DIVIDER } = require('../src/utils/whatsapp-format');
const { checkTextFromUser, contentTokens } = require('../src/utils/llm-output-validator');
const { stripExampleLines, sanitizeAssistantHistoryForLLM } = require('../src/utils/history-sanitizer');
const { filterToCurrentSession } = require('../src/utils/history-session-filter');
const { sanitizeTemplateParam } = require('../src/utils/whatsapp-24h');
const { maskPhone } = require('../src/utils/format-phone');

// ══════════════════════════════════════════════════════════════════════════
// 1. mime-detect — magic-byte sniffing (SECURITY)
// ══════════════════════════════════════════════════════════════════════════

describe('mime-detect: sniff()', () => {
  it('detects PDF from %PDF magic', () => {
    assert.equal(sniff(Buffer.from('%PDF-1.7\n%âãÏÓ')), 'pdf');
  });

  it('detects PNG from 8-byte signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    assert.equal(sniff(png), 'png');
  });

  it('detects JPEG from FF D8 FF', () => {
    assert.equal(sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])), 'jpeg');
  });

  it('detects GIF (GIF87a and GIF89a share the GIF8 prefix)', () => {
    assert.equal(sniff(Buffer.from('GIF89a\x01\x00')), 'gif');
    assert.equal(sniff(Buffer.from('GIF87a\x01\x00')), 'gif');
  });

  it('detects WebP via RIFF header + WEBP tail at offset 8', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
    assert.equal(sniff(webp), 'webp');
  });

  it('detects WAV via RIFF header + WAVE tail (not confused with WebP)', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x08, 0, 0]), Buffer.from('WAVEfmt ')]);
    assert.equal(sniff(wav), 'wav');
  });

  it('detects MP4 via ftyp box at offset 4', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
    assert.equal(sniff(mp4), 'mp4');
  });

  it('labels M4A files as mp4 (generic ftyp rule wins)', () => {
    // NOTE: possible bug — the m4a entry ('ftypM4A' at offset 4) appears
    // AFTER the generic mp4 entry ('ftyp' at offset 4) in the MAGIC table,
    // so it can never match despite the "more-specific prefixes first"
    // comment in src/utils/mime-detect.js. sniff() returns 'mp4' for M4A.
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(8)]);
    assert.equal(sniff(m4a), 'mp4');
  });

  it('detects MP3 with ID3 tag and raw MPEG frame sync', () => {
    assert.equal(sniff(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00])), 'mp3'); // "ID3"
    assert.equal(sniff(Buffer.from([0xFF, 0xFB, 0x90, 0x64])), 'mp3'); // frame sync
  });

  it('detects ZIP (also docx/xlsx/pptx containers)', () => {
    assert.equal(sniff(Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00])), 'zip');
  });

  it('detects legacy OLE2 Office files', () => {
    const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00]);
    assert.equal(sniff(ole), 'ole2');
  });

  it('falls back to text for printable-ASCII content (CSV)', () => {
    assert.equal(sniff(Buffer.from('name,email\nalice,alice@example.com\n')), 'text');
  });

  it('returns null for binary garbage', () => {
    assert.equal(sniff(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x9C, 0x80, 0x00])), null);
  });

  it('returns null for empty, too-short, and non-buffer input', () => {
    assert.equal(sniff(Buffer.alloc(0)), null);
    assert.equal(sniff(Buffer.from([0x25, 0x50, 0x44])), null); // 3 bytes: "%PD"
    assert.equal(sniff('not a buffer'), null);
    assert.equal(sniff(null), null);
  });
});

describe('mime-detect: validate()', () => {
  const pdf = Buffer.from('%PDF-1.4 fake body');

  it('accepts a matching claimed MIME', () => {
    assert.deepEqual(validate(pdf, 'application/pdf'), { ok: true, detected: 'pdf' });
  });

  it('rejects claimed MIME that mismatches the sniffed type (polyglot defense)', () => {
    // A "PNG" that is actually a PDF must be rejected.
    const res = validate(pdf, 'image/png');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'mismatch');
    assert.equal(res.detected, 'pdf');
  });

  it('rejects an executable-ish binary claiming to be a PDF as unknown', () => {
    const fakePdf = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ header
    const res = validate(fakePdf, 'application/pdf');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unknown');
  });

  it('rejects empty/nullish buffers with reason "empty"', () => {
    assert.deepEqual(validate(Buffer.alloc(0), 'application/pdf'), { ok: false, reason: 'empty' });
    assert.deepEqual(validate(null, 'application/pdf'), { ok: false, reason: 'empty' });
  });

  it('rejects unknown types by default, allows them with allowUnknown', () => {
    const junk = Buffer.from([0x00, 0x9C, 0x80, 0x00, 0x01, 0x02]);
    assert.deepEqual(validate(junk, 'application/octet-stream'), { ok: false, reason: 'unknown' });
    assert.deepEqual(
      validate(junk, 'application/octet-stream', { allowUnknown: true }),
      { ok: true, detected: 'unknown' }
    );
  });

  it('accepts when no MIME is claimed at all', () => {
    assert.deepEqual(validate(pdf, undefined), { ok: true, detected: 'pdf' });
  });

  it('is case-insensitive on the claimed MIME and tolerates parameters', () => {
    assert.equal(validate(pdf, 'APPLICATION/PDF').ok, true);
    assert.equal(validate(pdf, 'application/pdf;charset=binary').ok, true);
  });

  it('accepts a docx claim on a zip container', () => {
    const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const res = validate(zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.deepEqual(res, { ok: true, detected: 'zip' });
  });

  it('accepts text/csv for printable content, rejects image claim for it', () => {
    const csv = Buffer.from('a,b,c\n1,2,3\n');
    assert.equal(validate(csv, 'text/csv').ok, true);
    assert.equal(validate(csv, 'image/png').ok, false);
  });

  it('rejects an empty-zip (PK\\x05\\x06) even with a zip claim', () => {
    // NOTE: possible bug — sniff() labels PK\x05\x06 as 'zip-empty', but
    // allowedMap in validate() has no 'zip-empty' key, so ANY claimed MIME
    // (even application/zip) is rejected as a mismatch for empty archives.
    const emptyZip = Buffer.from([0x50, 0x4B, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00]);
    const res = validate(emptyZip, 'application/zip');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'mismatch');
    assert.equal(res.detected, 'zip-empty');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. whatsapp-format — markdownToWhatsApp
// ══════════════════════════════════════════════════════════════════════════

describe('whatsapp-format: markdownToWhatsApp()', () => {
  it('converts **bold** to *bold*', () => {
    assert.equal(markdownToWhatsApp('This is **bold** text'), 'This is *bold* text');
  });

  it('converts __bold__ to *bold* and leaves _italic_ alone', () => {
    assert.equal(markdownToWhatsApp('__strong__ and _soft_'), '*strong* and _soft_');
  });

  it('converts ***bold italic*** to *_text_*', () => {
    assert.equal(markdownToWhatsApp('***very important***'), '*_very important_*');
  });

  it('converts ATX headings of every level to bold lines', () => {
    assert.equal(markdownToWhatsApp('# Title'), '*Title*');
    assert.equal(markdownToWhatsApp('### Deep Section'), '*Deep Section*');
    assert.equal(markdownToWhatsApp('## Closed Heading ##'), '*Closed Heading*');
  });

  it('converts horizontal rules (---, ***, ___) to the unicode divider', () => {
    assert.equal(markdownToWhatsApp('---'), WHATSAPP_DIVIDER);
    assert.equal(markdownToWhatsApp('***'), WHATSAPP_DIVIDER);
    assert.equal(markdownToWhatsApp('___'), WHATSAPP_DIVIDER);
    assert.equal(WHATSAPP_DIVIDER, '─'.repeat(20));
  });

  it('rewrites leading "* item" bullets to "- item" (indent preserved)', () => {
    assert.equal(markdownToWhatsApp('* first\n  * nested'), '- first\n  - nested');
  });

  it('converts [text](url) links to "text (url)"', () => {
    assert.equal(
      markdownToWhatsApp('See [the docs](https://example.com/a?b=1) now'),
      'See the docs (https://example.com/a?b=1) now'
    );
  });

  it('handles a mixed multi-line document without collapsing newlines', () => {
    const input = '## Summary\n\n* **Task one** done\n* See [link](https://x.io)\n\n---\nPlain tail';
    const expected = `*Summary*\n\n- *Task one* done\n- See link (https://x.io)\n\n${WHATSAPP_DIVIDER}\nPlain tail`;
    assert.equal(markdownToWhatsApp(input), expected);
  });

  it('passes plain text and code blocks through unchanged', () => {
    assert.equal(markdownToWhatsApp('just a normal sentence.'), 'just a normal sentence.');
    const code = '```\nconst x = 1;\n```';
    assert.equal(markdownToWhatsApp(code), code);
  });

  it('returns non-string / empty input as-is', () => {
    assert.equal(markdownToWhatsApp(null), null);
    assert.equal(markdownToWhatsApp(undefined), undefined);
    assert.equal(markdownToWhatsApp(42), 42);
    assert.equal(markdownToWhatsApp(''), '');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. llm-output-validator — context-bleed detection
// ══════════════════════════════════════════════════════════════════════════

describe('llm-output-validator: contentTokens()', () => {
  it('lowercases, strips punctuation, drops stop words and short tokens', () => {
    assert.deepEqual(
      contentTokens('Remind me to call Doctor Sharma!'),
      ['call', 'doctor', 'sharma']
    );
  });

  it('keeps alphanumeric tokens of 3+ chars and returns [] for stop-word-only text', () => {
    assert.deepEqual(contentTokens('meeting at 2pm room404'), ['meeting', '2pm', 'room404']);
    assert.deepEqual(contentTokens('the and for you'), []);
    assert.deepEqual(contentTokens(''), []);
    assert.deepEqual(contentTokens(null), []);
  });
});

describe('llm-output-validator: checkTextFromUser()', () => {
  const userMsg = 'Remind me to submit the visa documents to the consulate tomorrow morning';

  it('accepts a verbatim substring of the user message (case-insensitive)', () => {
    const res = checkTextFromUser('Submit the VISA documents', userMsg);
    assert.equal(res.ok, true);
    assert.equal(res.suspicious, false);
    assert.equal(res.reason, 'verbatim');
    assert.equal(res.overlap, 1);
  });

  it('accepts a paraphrase with strong token overlap', () => {
    const res = checkTextFromUser('submit visa documents consulate ASAP', userMsg);
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'sufficient_overlap');
    assert.ok(res.overlap >= 0.3);
    assert.ok(res.matched >= 2);
  });

  it('flags text with zero overlap as context bleed', () => {
    const res = checkTextFromUser('buy groceries from the market', userMsg);
    assert.equal(res.ok, false);
    assert.equal(res.suspicious, true);
    assert.equal(res.overlap, 0);
    assert.equal(res.reason, 'too_few_matched_tokens');
  });

  it('flags text where only one incidental token matches', () => {
    const res = checkTextFromUser('documents shredder blender toaster', userMsg);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'too_few_matched_tokens');
    assert.equal(res.matched, 1);
  });

  it('accepts a single-token output at >=0.8 overlap despite matched < 2', () => {
    // "Documents?!" is not a verbatim substring (punctuation differs) but
    // its lone content token matches → overlap 1 → rule (b) accepts it.
    const res = checkTextFromUser('Documents?!', userMsg);
    assert.equal(res.ok, true);
    assert.equal(res.overlap, 1);
  });

  it('is punctuation- and case-insensitive when comparing tokens', () => {
    const res = checkTextFromUser('SUBMIT... VISA!!! *documents*', userMsg);
    assert.equal(res.ok, true);
    assert.equal(res.overlap, 1);
  });

  it('accepts very short outputs without validating them', () => {
    const res = checkTextFromUser('ok', userMsg);
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'too_short_to_validate');
  });

  it('accepts outputs made only of stop words (nothing to compare)', () => {
    const res = checkTextFromUser('the and that', 'completely unrelated user text');
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'no_content_tokens');
  });

  it('flags plausible-looking output when the user message is empty', () => {
    const res = checkTextFromUser('call priya about lease renewal', '');
    assert.equal(res.ok, false);
    assert.equal(res.suspicious, true);
  });

  it('honors a custom minOverlap threshold', () => {
    // 2 of 4 tokens match → overlap 0.5: passes at default 0.3, fails at 0.6.
    const llm = 'visa documents zebra quokka';
    assert.equal(checkTextFromUser(llm, userMsg).ok, true);
    assert.equal(checkTextFromUser(llm, userMsg, { minOverlap: 0.6 }).ok, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. history-sanitizer
// ══════════════════════════════════════════════════════════════════════════

describe('history-sanitizer: stripExampleLines()', () => {
  it('removes Example:/Try:/Like:/For example: prefixed lines', () => {
    const input = 'What should the reminder say?\nExample: "Remind Sneha: kainsl vn en too"\nTry: send docs\nLIKE: this\nFor example: that';
    assert.equal(stripExampleLines(input), 'What should the reminder say?');
  });

  it('strips indented example lines (leading whitespace allowed)', () => {
    assert.equal(stripExampleLines('Reply with a time.\n   Example: 5pm today'), 'Reply with a time.');
  });

  it('preserves mid-sentence mentions of "for example" and example.com', () => {
    const s = 'You could, for example, ping me later. Docs at example.com: see there.';
    assert.equal(stripExampleLines(s), s);
  });

  it('collapses the 3+ newline gap left by a stripped line', () => {
    assert.equal(stripExampleLines('before\n\nExample: gone\n\nafter'), 'before\n\nafter');
  });

  it('returns non-string and empty input untouched', () => {
    assert.equal(stripExampleLines(null), null);
    assert.equal(stripExampleLines(''), '');
    assert.equal(stripExampleLines(undefined), undefined);
  });
});

describe('history-sanitizer: sanitizeAssistantHistoryForLLM()', () => {
  it('strips example lines from assistant turns only', () => {
    const messages = [
      { role: 'user', content: 'Example: my user text must survive' },
      { role: 'assistant', content: 'Sure!\nExample: "Remind X: stale junk"' },
      { role: 'system', content: 'Example: system line survives too' },
    ];
    const out = sanitizeAssistantHistoryForLLM(messages);
    assert.equal(out[0].content, 'Example: my user text must survive');
    assert.equal(out[1].content, 'Sure!');
    assert.equal(out[2].content, 'Example: system line survives too');
  });

  it('leaves normal assistant content untouched and does not mutate input', () => {
    const userMsg = { role: 'user', content: 'hi' };
    const messages = [
      userMsg,
      { role: 'assistant', content: 'Done. Anything else?' },
      { role: 'assistant', content: 'ok\nTry: this' },
    ];
    const out = sanitizeAssistantHistoryForLLM(messages);
    assert.equal(out[0], userMsg); // non-assistant turns keep their reference
    assert.equal(out[1].content, 'Done. Anything else?'); // content unchanged
    assert.notEqual(out[1], messages[1]); // assistant turns are cloned copies
    assert.equal(messages[2].content, 'ok\nTry: this'); // input not mutated
    assert.equal(out[2].content, 'ok');
  });

  it('handles non-array input and messages with odd shapes', () => {
    assert.deepEqual(sanitizeAssistantHistoryForLLM(null), []);
    assert.deepEqual(sanitizeAssistantHistoryForLLM(undefined), []);
    const weird = [null, { role: 'assistant' }, { role: 'assistant', content: '' }];
    assert.deepEqual(sanitizeAssistantHistoryForLLM(weird), weird);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. history-session-filter
// ══════════════════════════════════════════════════════════════════════════

describe('history-session-filter: filterToCurrentSession()', () => {
  const t = (iso) => ({ role: 'user', content: 'm', created_at: iso });

  it('drops messages older than the session gap (default 60 min)', () => {
    const messages = [
      t('2026-07-11T09:00:00Z'),
      t('2026-07-11T09:05:00Z'),
      t('2026-07-11T09:10:00Z'),
      // ── 2 hour gap: session boundary ──
      t('2026-07-11T11:10:00Z'),
      t('2026-07-11T11:12:00Z'),
    ];
    const out = filterToCurrentSession(messages);
    assert.equal(out.length, 2);
    assert.equal(out[0].created_at, '2026-07-11T11:10:00Z');
  });

  it('keeps everything when all messages are close together', () => {
    const messages = [
      t('2026-07-11T09:00:00Z'),
      t('2026-07-11T09:05:00Z'),
      t('2026-07-11T09:59:00Z'),
    ];
    assert.deepEqual(filterToCurrentSession(messages), messages);
  });

  it('uses only the MOST RECENT boundary (older gaps ignored)', () => {
    const messages = [
      t('2026-07-10T09:00:00Z'),
      // day-long gap
      t('2026-07-11T09:00:00Z'),
      // 3h gap — this is the latest boundary
      t('2026-07-11T12:00:00Z'),
    ];
    const out = filterToCurrentSession(messages);
    assert.equal(out.length, 1);
    assert.equal(out[0].created_at, '2026-07-11T12:00:00Z');
  });

  it('respects a custom sessionGapMinutes and treats an exact gap as same-session', () => {
    const messages = [
      t('2026-07-11T09:00:00Z'),
      t('2026-07-11T09:15:00Z'), // 15 min later
    ];
    // gap must be STRICTLY greater than the threshold
    assert.equal(filterToCurrentSession(messages, 15).length, 2);
    assert.equal(filterToCurrentSession(messages, 10).length, 1);
  });

  it('returns [] for empty/nullish input and single rows as-is', () => {
    assert.deepEqual(filterToCurrentSession([]), []);
    assert.deepEqual(filterToCurrentSession(null), []);
    assert.deepEqual(filterToCurrentSession(undefined), []);
    const one = [t('2026-07-11T09:00:00Z')];
    assert.equal(filterToCurrentSession(one), one);
  });

  it('returns the list unchanged when any row lacks a parseable timestamp', () => {
    const messages = [
      t('2026-07-10T09:00:00Z'),
      { role: 'user', content: 'no timestamp' },
      t('2026-07-11T12:00:00Z'),
    ];
    assert.equal(filterToCurrentSession(messages), messages);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. whatsapp-24h — sanitizeTemplateParam (pure)
// ══════════════════════════════════════════════════════════════════════════

describe('whatsapp-24h: sanitizeTemplateParam()', () => {
  it('replaces newlines and tabs with the " · " separator', () => {
    assert.equal(sanitizeTemplateParam('line1\nline2'), 'line1 · line2');
    assert.equal(sanitizeTemplateParam('a\tb'), 'a · b');
  });

  it('collapses consecutive newline/tab runs into a single separator', () => {
    assert.equal(sanitizeTemplateParam('a\r\n\t\nb'), 'a · b');
  });

  it('caps 5+ consecutive spaces at exactly 4 (Meta error 132018 rule)', () => {
    assert.equal(sanitizeTemplateParam('a      b'), 'a    b'); // 6 → 4
    assert.equal(sanitizeTemplateParam('a    b'), 'a    b');   // 4 stays 4
    assert.equal(sanitizeTemplateParam('a   b'), 'a   b');     // 3 untouched
  });

  it('trims surrounding whitespace', () => {
    assert.equal(sanitizeTemplateParam('  hello  '), 'hello');
  });

  it('caps length at 1024 characters', () => {
    assert.equal(sanitizeTemplateParam('x'.repeat(2000)).length, 1024);
    assert.equal(sanitizeTemplateParam('x'.repeat(1024)).length, 1024);
  });

  it('coerces null/undefined to empty string and non-strings to strings', () => {
    assert.equal(sanitizeTemplateParam(null), '');
    assert.equal(sanitizeTemplateParam(undefined), '');
    assert.equal(sanitizeTemplateParam(42), '42');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. format-phone — maskPhone
// ══════════════════════════════════════════════════════════════════════════

describe('format-phone: maskPhone()', () => {
  it('masks a +CC number keeping country code and last 4 digits', () => {
    assert.equal(maskPhone('+919812345678'), '+91 ***5678');
    assert.equal(maskPhone('919812345678'), '+91 ***5678'); // no plus, same digits
  });

  it('masks a bare 10-digit number with star padding', () => {
    assert.equal(maskPhone('9812345678'), '+******5678');
  });

  it('strips formatting characters before masking', () => {
    assert.equal(maskPhone('(408) 555-1234'), '+******1234');
  });

  it('handles very short numbers without masking', () => {
    assert.equal(maskPhone('123'), '+123');
    assert.equal(maskPhone('1234'), '+1234'); // exactly 4 digits → nothing to pad
  });

  it('returns empty string for empty/nullish input', () => {
    assert.equal(maskPhone(''), '');
    assert.equal(maskPhone(null), '');
    assert.equal(maskPhone(undefined), '');
  });
});
