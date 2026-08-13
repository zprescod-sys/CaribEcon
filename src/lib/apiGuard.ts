/* Shared auth/CORS/rate-limit guard for AI-spending Vercel Functions (POST /api/research today,
   POST /api/ask once it exists). Copied out of api/research.ts, not imported from it: that file
   is frozen for the buildathon (see "Active build" in CLAUDE.md), so a new endpoint gets the
   same protections without ever touching it. If the policy changes, update both copies by hand —
   that duplication is the deliberate cost of the freeze. */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-CaribEcon-Token',
} as const;

/* Best-effort, per-instance rate limiting. Fluid Compute reuses instances across requests so
   this does catch the common case, but it is a cost guard, not a security boundary — several
   instances each keep their own counter. The real ceilings are a token cap on the caller's side
   and the auth check below. */
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export type TokenCheck =
  | { ok: true }
  | { ok: false; status: 503; error: 'not_configured'; message: string }
  | { ok: false; status: 401; error: 'unauthorized'; message: string };

/* Fail closed: an unset token would otherwise leave a token-spending endpoint open to the world
   the moment it deploys, which is a worse failure than a clear 503. envVar defaults to the
   existing client-visible cost gate (CLAUDE.md: "CARIBECON_RESEARCH_TOKEN is an existing
   client-visible cost gate, not a provider secret") so today's single token keeps working for a
   second endpoint without any config change; pass a different envVar if that ever needs to
   diverge. */
export function checkToken(request: Request, envVar = 'CARIBECON_RESEARCH_TOKEN'): TokenCheck {
  const expected = process.env[envVar];
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'not_configured',
      message: `${envVar} is not set on the server.`,
    };
  }
  if (request.headers.get('X-CaribEcon-Token') !== expected) {
    return { ok: false, status: 401, error: 'unauthorized', message: 'Invalid or missing token.' };
  }
  return { ok: true };
}
