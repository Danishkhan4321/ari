'use strict';

/**
 * Phone-display formatter (RC #2 fix).
 *
 * Centralized way to render a phone number as a human-readable name for
 * display in chat replies. Replaces the 8+ scattered `+${phone}` raw
 * concatenations that leak phone numbers into UX surfaces.
 *
 * Strategy:
 *   1. Look up phone in the OWNER's contacts (per-user, no cross-leakage)
 *   2. If found → return contact name
 *   3. If not found → return masked phone "+91 ***1234"
 *   4. Cache results for 60s (BoundedMap, auto-evict)
 *
 * Async because it queries the DB. Callers needing sync formatting can
 * use `maskPhone()` for the privacy-preserving fallback.
 */

const BoundedMap = require('./bounded-map');

const _cache = new BoundedMap(2000, 60 * 1000);

/**
 * Mask a raw phone for privacy when no name is available.
 *  +919999999999 → "+91 ***9999"
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return `+${digits}`;
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const last4 = digits.slice(-4);
  return cc ? `+${cc} ***${last4}` : `+${last4.padStart(digits.length, '*')}`;
}

/**
 * Format a phone for display, preferring the owner's contact name.
 *
 * @param {string} phone        - the phone to render (user being referenced)
 * @param {string} ownerPhone   - the user whose contacts we should look in
 * @returns {Promise<string>}    - "Akash" (name) or "+91 ***1234" (masked phone)
 */
async function formatPhoneAsContact(phone, ownerPhone) {
  if (!phone) return '';
  if (!ownerPhone) return maskPhone(phone);

  const key = `${ownerPhone}::${phone}`;
  const cached = _cache.get(key);
  if (cached !== undefined) return cached;

  let result;
  try {
    const contactService = require('../services/contact.service');
    const contact = await contactService.findByPhone(ownerPhone, phone);
    result = contact?.name || maskPhone(phone);
  } catch (_) {
    result = maskPhone(phone);
  }

  _cache.set(key, result);
  return result;
}

/**
 * Batch helper — look up multiple phones at once. Useful in list renderers.
 * @param {string[]} phones
 * @param {string} ownerPhone
 * @returns {Promise<Map<string, string>>}  phone -> name|masked
 */
async function formatManyPhones(phones, ownerPhone) {
  const out = new Map();
  if (!Array.isArray(phones) || phones.length === 0) return out;
  const unique = [...new Set(phones.filter(Boolean))];
  await Promise.all(
    unique.map(async p => {
      out.set(p, await formatPhoneAsContact(p, ownerPhone));
    })
  );
  return out;
}

module.exports = { formatPhoneAsContact, formatManyPhones, maskPhone };
