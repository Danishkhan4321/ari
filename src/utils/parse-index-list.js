'use strict';

/**
 * Parse a natural-language index list (RC #5 fix).
 *
 * Users say "1 & 2", "1, 2, 3", "1-5", "all", "first three", "the second one".
 * Existing tool handlers accept only a single integer, so multi-item batches
 * silently get partially executed (the cancel-reminder bug).
 *
 * This util normalizes any of the above into `{ ids: number[], all: boolean }`.
 *
 * Examples:
 *   parseIndexList("1 & 2")            → { ids: [1, 2], all: false }
 *   parseIndexList("1, 2, 3")          → { ids: [1, 2, 3], all: false }
 *   parseIndexList("1-3")              → { ids: [1, 2, 3], all: false }
 *   parseIndexList("delete 5 and 6")   → { ids: [5, 6], all: false }
 *   parseIndexList("cancel all")       → { ids: [], all: true }
 *   parseIndexList("first three")      → { ids: [1, 2, 3], all: false }
 *   parseIndexList("the second one")   → { ids: [2], all: false }
 *   parseIndexList("last one")         → { ids: [], all: false, last: true }
 *   parseIndexList("nothing relevant") → { ids: [], all: false }
 */

const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5,
  '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10,
};

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const MAX_RANGE = 50; // sanity cap on "1-100000"
const MAX_IDS   = 50;

/**
 * @param {string} text
 * @returns {{ ids: number[], all: boolean, last?: boolean }}
 */
function parseIndexList(text) {
  const out = { ids: [], all: false };
  if (!text || typeof text !== 'string') return out;

  const lower = text.toLowerCase();

  // "all" / "all of them" / "everything"
  if (/\b(all|everyone|everything|sab|sabhi|all of them)\b/.test(lower)) {
    out.all = true;
    return out;
  }

  // "last one" / "the last"
  if (/\b(the\s+)?last(\s+one)?\b/.test(lower)) {
    out.last = true;
  }

  const idSet = new Set();

  // Ranges: "1-3", "1 to 3", "1 through 3", "from 2 to 5"
  for (const m of lower.matchAll(/\b(\d+)\s*(?:-|–|—|to|through|thru)\s*(\d+)\b/g)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (!isNaN(a) && !isNaN(b) && a <= b && (b - a) < MAX_RANGE) {
      for (let i = a; i <= b; i++) idSet.add(i);
    }
  }

  // "first three" / "first 5" / "top three"
  for (const m of lower.matchAll(/\b(?:first|top)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g)) {
    const n = NUMBER_WORDS[m[1]] ?? parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n <= MAX_RANGE) {
      for (let i = 1; i <= n; i++) idSet.add(i);
    }
  }

  // Ordinals: "the second one", "first one", "3rd one"
  for (const m of lower.matchAll(/\b(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)(?:\s+one)?\b/g)) {
    const n = ORDINALS[m[1]];
    if (n) idSet.add(n);
  }

  // Bare integers (also catches "#3", "task 5")
  for (const m of lower.matchAll(/(?:^|\s|#|,)(\d+)\b/g)) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n < 1000) idSet.add(n);
  }

  out.ids = [...idSet].sort((a, b) => a - b).slice(0, MAX_IDS);
  return out;
}

module.exports = { parseIndexList };
