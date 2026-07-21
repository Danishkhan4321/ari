const exaService = require('./exa.service');

const EMPTY_RESULT = Object.freeze({
  email: null,
  company: null,
  title: null,
  linkedin_url: null,
  website: null,
});

function parseEnrichmentOutput(output) {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ...EMPTY_RESULT };
    }
  }
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== 'object') return { ...EMPTY_RESULT };
  if (value.content && typeof value.content === 'object') value = value.content;

  const text = (key) => {
    const candidate = value[key];
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  };

  return {
    email: text('email'),
    company: text('company'),
    title: text('title'),
    linkedin_url: text('linkedin_url'),
    website: text('website'),
  };
}

async function enrichContact(profile) {
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  if (!name) return { ok: false, error: 'Contact name is required.' };
  if (!exaService.isConfigured()) {
    return { ok: false, error: 'Contact enrichment is not configured.' };
  }

  const context = [profile.company, profile.title, profile.email, profile.linkedin_url, profile.website]
    .filter(value => typeof value === 'string' && value.trim())
    .join(', ');
  const query = [
    `Find the public professional profile for ${name}.`,
    context ? `Known details: ${context}.` : '',
    'Return only details supported by public sources. Use an empty string for every field that cannot be verified.',
  ].filter(Boolean).join(' ');

  const result = await exaService.exaStructuredSearch({
    query,
    type: 'deep-lite',
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Verified public professional email, otherwise empty.' },
        company: { type: 'string', description: 'Current company, otherwise empty.' },
        title: { type: 'string', description: 'Current professional title, otherwise empty.' },
        linkedin_url: { type: 'string', description: 'Verified LinkedIn profile URL, otherwise empty.' },
        website: { type: 'string', description: 'Verified company or personal website URL, otherwise empty.' },
      },
      required: ['email', 'company', 'title', 'linkedin_url', 'website'],
      additionalProperties: false,
    },
  });

  if (!result.ok) {
    return { ok: false, error: result.degraded ? 'Contact enrichment is not configured.' : 'Contact enrichment failed.' };
  }

  const data = parseEnrichmentOutput(result.output);
  const found = Object.values(data).some(Boolean);
  return found
    ? { ok: true, data }
    : { ok: false, error: 'No verified public details were found.' };
}

module.exports = { enrichContact, parseEnrichmentOutput };
