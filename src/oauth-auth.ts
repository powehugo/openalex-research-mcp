import { createPublicKey, verify } from 'node:crypto';
import { IncomingMessage } from 'node:http';

type JwtHeader = { alg?: string; kid?: string };
type JwtPayload = {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  nbf?: number;
  scope?: string;
  sub?: string;
};

type Jwk = { [key: string]: string | undefined; kid?: string; alg?: string; use?: string };

let jwksCache: { expiresAt: number; keys: Jwk[]; issuer: string } | undefined;

function decodeJsonPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function normalizedIssuer(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

async function getJwks(issuer: string): Promise<Jwk[]> {
  const normalized = normalizedIssuer(issuer);
  if (jwksCache && jwksCache.issuer === normalized && jwksCache.expiresAt > Date.now()) {
    return jwksCache.keys;
  }
  const response = await fetch(new URL('.well-known/jwks.json', normalized));
  if (!response.ok) throw new Error(`OAuth JWKS request failed (${response.status})`);
  const body = await response.json() as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error('OAuth JWKS response did not contain keys');
  jwksCache = { issuer: normalized, keys: body.keys, expiresAt: Date.now() + 10 * 60_000 };
  return body.keys;
}

export function oauthConfigured(): boolean {
  return Boolean(process.env.OAUTH_ISSUER_URL?.trim() && process.env.OAUTH_AUDIENCE?.trim());
}

export function oauthProtectedResourceMetadata(): Record<string, unknown> {
  const issuer = normalizedIssuer(process.env.OAUTH_ISSUER_URL?.trim() || '');
  return {
    resource: process.env.OAUTH_AUDIENCE?.trim(),
    bearer_methods_supported: ['header'],
    authorization_servers: [issuer],
    resource_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  };
}

export async function hasValidOAuthToken(req: IncomingMessage): Promise<boolean> {
  const token = bearerToken(req);
  const issuerValue = process.env.OAUTH_ISSUER_URL?.trim();
  const audience = process.env.OAUTH_AUDIENCE?.trim();
  if (!token || !issuerValue || !audience) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = decodeJsonPart<JwtHeader>(parts[0]);
    const payload = decodeJsonPart<JwtPayload>(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) return false;

    const issuer = normalizedIssuer(issuerValue);
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audiences.includes(audience)) return false;
    if (typeof payload.exp !== 'number' || payload.exp <= now - 30) return false;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return false;

    const jwk = (await getJwks(issuer)).find(key => key.kid === header.kid && (!key.alg || key.alg === 'RS256'));
    if (!jwk) return false;
    return verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    return false;
  }
}
