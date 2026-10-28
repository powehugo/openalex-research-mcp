/**
 * Shared pool of OpenAlex API keys.
 *
 * Keys come from OPENALEX_API_KEYS (comma, semicolon, whitespace or newline
 * separated) plus the legacy single OPENALEX_API_KEY. The pool hands out the
 * first key that is not parked. A key is parked:
 *   - until the next UTC midnight when OpenAlex says its daily budget is spent
 *     (OpenAlex resets each key's allowance at 00:00 UTC);
 *   - for a short cooldown on an ordinary 429 burst limit, escalating to the
 *     next UTC midnight if it keeps getting 429s;
 *   - until the process restarts when OpenAlex rejects it (401/403).
 */

const SHORT_COOLDOWN_MS = 60_000;
const STRIKES_BEFORE_DAY_PARK = 3;

type KeyState = { parkedUntil: number; strikes: number; invalid: boolean };

function parseKeys(): string[] {
  const raw = [process.env.OPENALEX_API_KEYS || '', process.env.OPENALEX_API_KEY || ''].join(',');
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const key = part.trim();
    if (key) seen.add(key);
  }
  return [...seen];
}

function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function looksLikeBudgetExhausted(body: unknown): boolean {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /budget|credit|allowance|quota|insufficient|daily|prepaid|balance/i.test(text);
}

class OpenAlexKeyPool {
  private keys = parseKeys();
  private state = new Map<string, KeyState>(this.keys.map(k => [k, { parkedUntil: 0, strikes: 0, invalid: false }]));

  get size(): number {
    return this.keys.length;
  }

  private usable(key: string, now: number): boolean {
    const s = this.state.get(key);
    return !!s && !s.invalid && s.parkedUntil <= now;
  }

  available(now = Date.now()): number {
    return this.keys.filter(k => this.usable(k, now)).length;
  }

  /** The key to use for the next request, or undefined when none is usable. */
  current(now = Date.now()): string | undefined {
    return this.keys.find(k => this.usable(k, now));
  }

  /** Call after a successful response so short-lived strikes reset. */
  markSuccess(key: string | undefined): void {
    const s = key ? this.state.get(key) : undefined;
    if (s) s.strikes = 0;
  }

  markInvalid(key: string): void {
    const s = this.state.get(key);
    if (s) s.invalid = true;
  }

  /** Handle a 429 for this key. Returns true if the key was parked for the day. */
  markRateLimited(key: string, responseBody: unknown, now = Date.now()): boolean {
    const s = this.state.get(key);
    if (!s) return false;
    s.strikes += 1;
    if (looksLikeBudgetExhausted(responseBody) || s.strikes >= STRIKES_BEFORE_DAY_PARK) {
      s.parkedUntil = nextUtcMidnight(now);
      s.strikes = 0;
      return true;
    }
    s.parkedUntil = now + SHORT_COOLDOWN_MS;
    return false;
  }

  status(now = Date.now()): { configured: number; available: number; invalid: number; parkedForDay: number } {
    let invalid = 0;
    let parkedForDay = 0;
    for (const s of this.state.values()) {
      if (s.invalid) invalid += 1;
      else if (s.parkedUntil > now + SHORT_COOLDOWN_MS) parkedForDay += 1;
    }
    return { configured: this.keys.length, available: this.available(now), invalid, parkedForDay };
  }
}

export const openAlexKeys = new OpenAlexKeyPool();
