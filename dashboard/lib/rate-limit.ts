// dashboard/lib/rate-limit.ts
// Lightweight in-memory rate limiter for the Next.js dashboard.
//
// The dashboard runs as a separate Next.js process from the bot, so we
// can't reuse the bot's BoundedMap-based limiter in src/middleware/
// abuse-protection.js. This is good enough for a single-instance
// deployment; if the dashboard ever scales horizontally, swap this for
// Upstash Ratelimit (which the bot can also share).
//
// Each bucket: { windowStart, count } per key. Old entries are GC'd
// on each access. Caller passes a window + max; we return whether the
// next attempt is allowed.

type Bucket = Map<string, { windowStart: number; count: number }>;

const buckets: Record<string, Bucket> = {};

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

export function rateLimit(
  bucketName: string,
  key: string,
  windowMs: number,
  max: number
): RateLimitResult {
  if (!buckets[bucketName]) buckets[bucketName] = new Map();
  const bucket = buckets[bucketName];
  const now = Date.now();

  // Lazy GC — drop entries whose window is already expired. Cheap enough
  // for small buckets; if this grows past a few thousand keys, swap to a
  // bounded LRU.
  for (const [k, v] of bucket) {
    if (now - v.windowStart >= windowMs) bucket.delete(k);
  }

  const entry = bucket.get(key);
  if (!entry) {
    bucket.set(key, { windowStart: now, count: 1 });
    return { allowed: true, count: 1, retryAfterMs: 0 };
  }
  entry.count++;
  if (entry.count > max) {
    return {
      allowed: false,
      count: entry.count,
      retryAfterMs: windowMs - (now - entry.windowStart),
    };
  }
  return { allowed: true, count: entry.count, retryAfterMs: 0 };
}

/**
 * Extract a usable client IP from a Next.js Request.
 * Honors X-Forwarded-For when running behind nginx/cloudflare.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  // Next.js doesn't expose req.ip on the Edge runtime; fall back to a
  // shared bucket. Production should always have XFF/Real-IP.
  return "unknown";
}
