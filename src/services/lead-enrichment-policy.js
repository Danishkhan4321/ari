'use strict';

const PROFILE_FIELDS = [
  'title', 'location', 'linkedin_url', 'website', 'company', 'company_domain',
  'company_description', 'company_industry', 'company_workforce',
  'company_headquarters', 'company_founded_year', 'company_funding', 'social_profiles'
];

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function tokens(value) {
  return clean(value).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function tokenSimilarity(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeUrl(value) {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeDomain(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  if (!raw.startsWith('+') && digits.length < 11) return null;
  return `+${digits}`;
}

function eligibility(lead) {
  if (!clean(lead?.name)) return { eligible: false, reason: 'Missing lead name' };
  const emailDomain = normalizeEmail(lead.email)?.split('@')[1];
  const hasStrongIdentifier = Boolean(
    normalizeUrl(lead.linkedin_url) || emailDomain || normalizeDomain(lead.company_domain)
    || clean(lead.company)
    || (clean(lead.company) && normalizeUrl(lead.website))
    || (clean(lead.company) && clean(lead.location))
  );
  return hasStrongIdentifier
    ? { eligible: true, reason: null }
    : { eligible: false, reason: 'Add a company, LinkedIn URL, work email, website, or location' };
}

function estimateCost(leadCount, requestedFields) {
  const count = Math.max(0, Math.min(100, Number(leadCount) || 0));
  const fields = new Set(requestedFields || []);
  const batches = Math.ceil(count / 10);
  const agentAndSearchCeiling = batches * 0.025 + count * 0.014;
  const contacts = count * ((fields.has('email') ? 0.02 : 0) + (fields.has('phone') ? 0.07 : 0));
  return Number((agentAndSearchCeiling + contacts).toFixed(6));
}

function normalizeResult(result) {
  const socialProfiles = Array.isArray(result?.social_profiles)
    ? [...new Set(result.social_profiles.map(normalizeUrl).filter(Boolean))].slice(0, 10)
    : [];
  return {
    matched_name: clean(result?.matched_name) || null,
    email: normalizeEmail(result?.work_email),
    phone: normalizePhone(result?.phone),
    title: clean(result?.title) || null,
    location: clean(result?.location) || null,
    linkedin_url: normalizeUrl(result?.linkedin_url),
    website: normalizeUrl(result?.company_website),
    company: clean(result?.company_name) || null,
    company_domain: normalizeDomain(result?.company_domain || result?.company_website),
    company_description: clean(result?.company_description) || null,
    company_industry: clean(result?.company_industry) || null,
    company_workforce: result?.company_workforce != null && Number.isInteger(Number(result.company_workforce)) && Number(result.company_workforce) >= 0 ? Number(result.company_workforce) : null,
    company_headquarters: clean(result?.company_headquarters) || null,
    company_founded_year: /^\d{4}$/.test(clean(result?.company_founded_year)) ? Number(result.company_founded_year) : null,
    company_funding: result?.company_funding && typeof result.company_funding === 'object' ? result.company_funding : null,
    social_profiles: socialProfiles.length ? socialProfiles : null,
    source_urls: Array.isArray(result?.source_urls)
      ? [...new Set(result.source_urls.map(normalizeUrl).filter(Boolean))].slice(0, 12)
      : [],
    match_evidence: clean(result?.match_evidence) || null,
    identity_verified: result?.identity_verified === true,
    identity_confidence: ['high', 'medium', 'low'].includes(result?.identity_confidence)
      ? result.identity_confidence
      : 'low',
  };
}

function isHighConfidenceMatch(input, result) {
  if (result?.identity_verified !== true || result?.identity_confidence !== 'high') return false;
  if (!Array.isArray(result.source_urls) || result.source_urls.length === 0) return false;
  if (tokens(input?.name).join(' ') !== tokens(result?.matched_name).join(' ')) return false;

  const inputEmailDomain = normalizeEmail(input?.email)?.split('@')[1] || null;
  const resultEmailDomain = normalizeEmail(result?.email)?.split('@')[1] || null;
  const inputDomain = normalizeDomain(input?.company_domain || input?.website) || inputEmailDomain;
  const resultDomain = normalizeDomain(result?.company_domain || result?.website) || resultEmailDomain;
  const sameProfile = normalizeUrl(input?.linkedin_url) && normalizeUrl(input?.linkedin_url) === normalizeUrl(result?.linkedin_url);
  const sameDomain = inputDomain && resultDomain && inputDomain === resultDomain;
  const sameLocation = clean(input?.location) && tokens(input.location).join(' ') === tokens(result?.location).join(' ');
  const closeCompany = tokenSimilarity(input?.company, result?.company) >= 0.5;
  return Boolean(sameProfile || sameDomain || sameLocation || closeCompany);
}

function classifyField(currentValue, proposedValue) {
  if (proposedValue == null || proposedValue === '' || (Array.isArray(proposedValue) && proposedValue.length === 0)) return 'empty';
  if (currentValue == null || currentValue === '' || (Array.isArray(currentValue) && currentValue.length === 0)) return 'apply';
  const current = JSON.stringify(currentValue).toLowerCase();
  const proposed = JSON.stringify(proposedValue).toLowerCase();
  return current === proposed ? 'unchanged' : 'ignored';
}

module.exports = {
  PROFILE_FIELDS,
  normalizeEmail,
  normalizeUrl,
  normalizeDomain,
  normalizePhone,
  eligibility,
  estimateCost,
  normalizeResult,
  isHighConfidenceMatch,
  classifyField,
};
