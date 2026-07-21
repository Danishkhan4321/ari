// dashboard/lib/csv.ts
// CSV / TSV parser + column mapper. Designed to handle the messy reality
// of "any export from any tool" — Gmail, LinkedIn Sales Nav, Apollo, Excel,
// Google Sheets, Notion, Airtable, HubSpot, Salesforce, plus hand-typed
// pastes. Three guarantees:
//   1. Both comma and tab separators are detected (paste from Excel/Sheets
//      gives you tabs, file uploads usually give you commas).
//   2. UTF-8 BOM and CR/LF variants are normalized.
//   3. Column auto-detection is followed by a user-facing override step
//      (see detectMapping + applyMapping).
//
// Dependency-free on purpose. papaparse ships ~50KB; we only need a
// fraction of it.

export type CsvRow = Record<string, string>;

// Standard fields go into typed columns on sales_leads / contacts.
// `custom:<label>` is captured into sales_leads.custom_fields JSONB so the
// user can preserve whatever extra columns their export has (Job Title,
// LinkedIn URL, Industry, etc.) without us having to schema them all.
//
// `first_name` + `last_name` are first-class so CSVs that split the
// person's name across two columns (LinkedIn, Apollo, Sales Nav, Sheets
// templates) map cleanly. At apply time they're concatenated into the
// final `name` field; if only one is provided we still get a usable
// name. A bare "name" mapping still works for sources that have a
// single full-name column.
export type FieldKey =
  | "name" | "first_name" | "last_name"
  | "email" | "phone" | "company"
  | "title" | "linkedin" | "website"
  | "ignore"
  | `custom:${string}`;

export const STANDARD_FIELDS: Exclude<FieldKey, `custom:${string}`>[] = [
  "ignore", "name", "first_name", "last_name",
  "email", "phone",
  "company", "title", "linkedin", "website",
];

// Human label per field — used by the dropdown in the mapping UI.
export const FIELD_LABELS: Record<Exclude<FieldKey, `custom:${string}`>, string> = {
  ignore: "— Ignore",
  name: "Full name",
  first_name: "First name",
  last_name: "Last name",
  email: "Email",
  phone: "Phone",
  company: "Company name",
  title: "Job title",
  linkedin: "LinkedIn URL",
  website: "Website",
};

// Helpers
export function isCustom(f: FieldKey): f is `custom:${string}` { return typeof f === "string" && f.startsWith("custom:"); }
export function customLabel(f: FieldKey): string { return isCustom(f) ? f.slice("custom:".length) : ""; }
export function asCustom(label: string): FieldKey { return `custom:${label}` as FieldKey; }

// One per CSV column. The user can flip any column to a different field
// (or to "ignore") in the mapping UI before import.
export type ColumnMapping = Record<string /* header */, FieldKey>;

// A row that's been resolved against a ColumnMapping.
export type MappedRow = {
  name: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  linkedin: string;
  website: string;
  customFields: Record<string, string>;
};

// ─── Parse ──────────────────────────────────────────────────────────────

export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  // Strip BOM + normalize CRLF
  const cleaned = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = cleaned.split("\n").filter(l => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const sep = detectSeparator(lines.slice(0, Math.min(5, lines.length)));
  const rawHeaders = splitLine(lines[0], sep);
  // Preserve the original header text so the mapper UI can show it,
  // but normalize for matching.
  const headers = rawHeaders.map(h => h.trim()).filter(h => h.length > 0);
  if (headers.length === 0) return { headers: [], rows: [] };
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    // Skip completely-empty rows
    if (cells.every(c => !c || !c.trim())) continue;
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] || "").trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

function detectSeparator(sampleLines: string[]): string {
  // Score each separator by how consistently it splits the sample lines
  // into the same number of cells. Tab beats comma when both are present
  // (paste from Sheets / Excel often has both).
  const candidates = ["\t", ",", ";", "|"];
  let best = ",";
  let bestScore = -1;
  for (const c of candidates) {
    const counts = sampleLines.map(l => splitLine(l, c).length);
    if (counts[0] < 2) continue; // header must split into 2+ columns
    const allEqual = counts.every(n => n === counts[0]);
    const score = counts[0] * (allEqual ? 10 : 1);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === sep) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ─── Auto-detect mapping ────────────────────────────────────────────────

// Synonyms per field. Order within a list matters when we score matches
// — more specific multi-word phrases beat generic single words. Across
// lists, we evaluate FIRST_NAME and LAST_NAME before NAME so a CSV with
// both "First Name" and "Last Name" columns gets two distinct mappings
// instead of both collapsing into "name".
const FIRST_NAME_SYNONYMS = [
  "first name", "firstname", "given name", "given", "fname", "forename",
];
const LAST_NAME_SYNONYMS = [
  "last name", "lastname", "surname", "family name", "lname",
];
const NAME_SYNONYMS = [
  "full name", "fullname", "contact name", "display name", "person", "name",
];
const EMAIL_SYNONYMS = [
  "primary email", "work email", "email address", "email_address",
  "emailaddress", "e-mail", "email", "mail", "e mail",
];
const PHONE_SYNONYMS = [
  "mobile phone", "work phone", "phone number", "phonenumber",
  "phone", "mobile", "cell", "whatsapp", "tel", "telephone",
  "msisdn", "contact number",
];
const COMPANY_SYNONYMS = [
  "company name", "company", "organization", "organisation", "org",
  "employer", "workplace", "account", "business", "firm",
];
const TITLE_SYNONYMS = [
  "job title", "position", "role", "designation", "title",
  "current position", "current role", "current title",
];
// LinkedIn synonyms target the column LinkedIn / Apollo / Sales Nav
// exports use. "Profile URL" alone is risky (could be a Twitter URL),
// so we also check for "linkedin" anywhere in the header.
const LINKEDIN_SYNONYMS = [
  "linkedin url", "linkedin profile", "linkedin link", "linkedin",
  "li url", "li profile",
];
// Website / company URL synonyms. We deliberately don't catch a bare
// "url" header here because that could be anything (LinkedIn, Twitter,
// blog, etc.). Match phrases that explicitly say site/web/domain.
const WEBSITE_SYNONYMS = [
  "website", "web site", "company website", "company url",
  "company site", "site", "homepage", "home page", "domain", "web",
];

export function detectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  // Default: ignore
  for (const h of headers) mapping[h] = "ignore";

  // Pass 1: precise multi-word matches that must beat broader catch-alls
  for (const h of headers) {
    const norm = normalize(h);
    if (mapping[h] !== "ignore") continue;
    if (matches(norm, FIRST_NAME_SYNONYMS)) mapping[h] = "first_name";
    else if (matches(norm, LAST_NAME_SYNONYMS)) mapping[h] = "last_name";
    else if (matches(norm, LINKEDIN_SYNONYMS)) mapping[h] = "linkedin";
    else if (matches(norm, WEBSITE_SYNONYMS)) mapping[h] = "website";
    else if (matches(norm, TITLE_SYNONYMS)) mapping[h] = "title";
  }

  // Pass 2: standard fields, including the catch-all "name"
  for (const h of headers) {
    const norm = normalize(h);
    if (mapping[h] !== "ignore") continue;
    if (matches(norm, EMAIL_SYNONYMS)) mapping[h] = "email";
    else if (matches(norm, PHONE_SYNONYMS)) mapping[h] = "phone";
    else if (matches(norm, COMPANY_SYNONYMS)) mapping[h] = "company";
    else if (matches(norm, NAME_SYNONYMS)) mapping[h] = "name";
  }

  // Pass 3: a generic "Profile URL" column — only claim it as LinkedIn
  // if it actually looks like one in the first row (best-effort).
  // Skipped here at detection time; row-level validation happens in
  // applyMapping if we want to be stricter.
  return mapping;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
}

function matches(normHeader: string, synonyms: string[]): boolean {
  // Exact match wins
  if (synonyms.includes(normHeader)) return true;
  // Otherwise: any synonym appears as a whole word (or substring for
  // single-word synonyms like "email").
  for (const syn of synonyms) {
    if (syn.includes(" ")) {
      if (normHeader.includes(syn)) return true;
    } else {
      // Single word — match when the header equals it, contains it as a
      // word boundary, or starts/ends with it.
      const re = new RegExp(`(^|\\b|[^a-z])${escapeRegex(syn)}($|\\b|[^a-z])`);
      if (re.test(normHeader)) return true;
    }
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Apply mapping → MappedRow[] ────────────────────────────────────────

// Resolve raw rows into the canonical {name, email, phone, company,
// customFields} shape using the user-confirmed mapping.
//
// Name resolution priority per row:
//   1. If first_name OR last_name is mapped → join "first last"
//   2. Otherwise fall back to a standalone "name" mapping
//
// Multiple columns can map to the same field (e.g. "Personal Email" +
// "Work Email" → first non-empty wins for email; multiple "name"
// columns are joined with spaces).
export function applyMapping(rows: CsvRow[], mapping: ColumnMapping): MappedRow[] {
  const out: MappedRow[] = [];
  const standard: Record<
    "name" | "first_name" | "last_name" | "email" | "phone"
    | "company" | "title" | "linkedin" | "website" | "ignore",
    string[]
  > = {
    name: [], first_name: [], last_name: [],
    email: [], phone: [],
    company: [], title: [], linkedin: [], website: [],
    ignore: [],
  };
  const customByLabel: Record<string, string[]> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (isCustom(field)) {
      const label = customLabel(field);
      if (!customByLabel[label]) customByLabel[label] = [];
      customByLabel[label].push(header);
    } else {
      standard[field].push(header);
    }
  }

  const hasSplitName = standard.first_name.length > 0 || standard.last_name.length > 0;

  for (const row of rows) {
    let name: string;
    if (hasSplitName) {
      // Join "First Last" from the split-name columns. If only one is
      // available we still get a usable name. Multiple columns mapped
      // to the same half (e.g. two First Name columns) are joined with
      // spaces too.
      const first = joinNonEmpty(standard.first_name.map(h => row[h]));
      const last = joinNonEmpty(standard.last_name.map(h => row[h]));
      name = [first, last].filter(Boolean).join(" ").slice(0, 200);
    } else {
      name = joinNonEmpty(standard.name.map(h => row[h])).slice(0, 200);
    }
    const emailRaw = firstNonEmpty(standard.email.map(h => row[h]));
    const phoneRaw = firstNonEmpty(standard.phone.map(h => row[h]));
    const company = firstNonEmpty(standard.company.map(h => row[h])).slice(0, 200);
    const title = firstNonEmpty(standard.title.map(h => row[h])).slice(0, 200);
    const linkedinRaw = firstNonEmpty(standard.linkedin.map(h => row[h]));
    const websiteRaw = firstNonEmpty(standard.website.map(h => row[h]));
    const customFields: Record<string, string> = {};
    for (const [label, headers] of Object.entries(customByLabel)) {
      const v = firstNonEmpty(headers.map(h => row[h]));
      if (v) customFields[label] = v.slice(0, 500);
    }
    out.push({
      name,
      email: cleanEmail(emailRaw),
      phone: cleanPhone(phoneRaw),
      company,
      title,
      linkedin: cleanLinkedin(linkedinRaw),
      website: cleanWebsite(websiteRaw),
      customFields,
    });
  }
  return out;
}

// Count rows that would be importable given current mapping.
// A row is importable if it has a name. Email and phone are optional —
// rows with just a name (and maybe linkedin / website / title /
// custom fields) land in sales_leads with NULL email so directories
// of name-only contacts (legal directories, conference attendee
// lists, etc.) still flow through.
export function countValid(mapped: MappedRow[]): number {
  return mapped.filter(r => r.name).length;
}

// Detailed per-rule analysis. Used by the mapping UI to break down
// rows by what contact info they have — even though we now import
// no-contact rows, the user still wants to know how many fall in each
// bucket so they can plan outreach.
export type MappingAnalysis = {
  total: number;
  valid: number;
  noName: number;        // skipped — no name = unimportable
  byContact: {
    withEmail: number;       // ready and has email
    withPhoneOnly: number;   // ready, phone but no email
    nameOnly: number;        // ready but no email AND no phone
  };
};

export function analyzeMapping(mapped: MappedRow[]): MappingAnalysis {
  const a: MappingAnalysis = {
    total: mapped.length,
    valid: 0,
    noName: 0,
    byContact: { withEmail: 0, withPhoneOnly: 0, nameOnly: 0 },
  };
  for (const r of mapped) {
    if (!r.name) { a.noName++; continue; }
    a.valid++;
    if (r.email) a.byContact.withEmail++;
    else if (r.phone) a.byContact.withPhoneOnly++;
    else a.byContact.nameOnly++;
  }
  return a;
}

function joinNonEmpty(parts: string[]): string {
  return parts.map(p => (p || "").trim()).filter(Boolean).join(" ");
}

function firstNonEmpty(parts: string[]): string {
  for (const p of parts) {
    const t = (p || "").trim();
    if (t) return t;
  }
  return "";
}

function cleanEmail(s: string): string {
  if (!s) return "";
  // Pull the first email-shaped token in case the cell has extra junk
  const m = s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  return (m ? m[0] : s).toLowerCase().slice(0, 200);
}

function cleanPhone(s: string): string {
  if (!s) return "";
  // Keep digits and a leading + if present
  const hasPlus = s.trim().startsWith("+");
  const digits = s.replace(/\D/g, "").slice(0, 20);
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

// Normalize a website URL: ensure it starts with https://, strip
// tracking params, accept bare domains like "example.com" or
// "example.com/about". Falsy / unrecognizable values are returned as-is
// (sliced) rather than dropped so the user can see what was in the
// CSV cell.
function cleanWebsite(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  let url = t.replace(/^["']|["']$/g, "");
  // Bare domain or path — add https://
  if (!/^https?:\/\//i.test(url)) {
    // Looks like a domain (has a dot, no spaces, no '@')?
    if (/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(\/.*)?$/i.test(url)) {
      url = `https://${url}`;
    }
  }
  try {
    const u = new URL(url);
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "ref", "fbclid", "gclid"]) {
      u.searchParams.delete(k);
    }
    return u.toString().slice(0, 500);
  } catch {
    return url.slice(0, 500);
  }
}

// Normalize a LinkedIn URL: drop tracking params, ensure it starts with
// https://, and accept bare profile slugs (e.g. "linkedin.com/in/danish"
// or "in/danish") by prefixing the host. If the cell doesn't look like
// a LinkedIn URL at all, we leave it as-is so the user can spot bad
// data on the lead detail page.
function cleanLinkedin(s: string): string {
  const t = (s || "").trim();
  if (!t) return "";
  // Strip surrounding quotes / whitespace
  let url = t.replace(/^["']|["']$/g, "");
  // Bare slug like "in/danish-khan-1234"
  if (/^in\/[a-zA-Z0-9_-]+$/.test(url)) {
    url = `https://www.linkedin.com/${url}`;
  }
  // Missing scheme — add it if it looks like a domain
  if (!/^https?:\/\//i.test(url) && /linkedin\.com\//i.test(url)) {
    url = `https://${url.replace(/^\/+/, "")}`;
  }
  // Strip URL query params we don't need
  try {
    const u = new URL(url);
    // Tracking junk + analytics params common in LinkedIn share URLs
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "trk", "lipi", "miniProfileUrn"]) {
      u.searchParams.delete(k);
    }
    return u.toString().slice(0, 500);
  } catch {
    return url.slice(0, 500);
  }
}

// ─── Legacy single-row mapper kept for back-compat (used by older code) ──

export function mapColumns(row: CsvRow): { name?: string; email?: string; phone?: string; company?: string } {
  const headers = Object.keys(row);
  const mapping = detectMapping(headers);
  const [mapped] = applyMapping([row], mapping);
  return {
    name: mapped.name || undefined,
    email: mapped.email || undefined,
    phone: mapped.phone || undefined,
    company: mapped.company || undefined,
  };
}
