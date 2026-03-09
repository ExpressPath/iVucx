import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ivucx_blue_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const MAX_LOGIN_FAILURES = 6;
export const LOCKOUT_MINUTES = 15;

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomToken(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

function groupToken(token, chunkSize) {
  const chunks = [];
  for (let i = 0; i < token.length; i += chunkSize) {
    chunks.push(token.slice(i, i + chunkSize));
  }
  return chunks.join('-');
}

export function generateAccountId() {
  return `VX-${groupToken(randomToken(72), 6)}`;
}

export function generateRecoveryPassword() {
  return `RCV-${groupToken(randomToken(48), 4)}`;
}

export function canonicalizeCredential(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function normalizeAccountId(input) {
  const canonical = canonicalizeCredential(input);
  const withPrefix = canonical.startsWith('VX') ? canonical : `VX${canonical}`;
  const body = withPrefix.slice(2);
  const display = `VX-${groupToken(body, 6)}`;
  return {
    canonical: withPrefix,
    display
  };
}

export function normalizeRecoveryPassword(input) {
  const canonical = canonicalizeCredential(input);
  const withPrefix = canonical.startsWith('RCV') ? canonical : `RCV${canonical}`;
  const body = withPrefix.slice(3);
  const display = `RCV-${groupToken(body, 4)}`;
  return {
    canonical: withPrefix,
    display
  };
}

export function hashRecoverySecret(normalizedRecovery) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(normalizedRecovery, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function verifyRecoverySecret(normalizedRecovery, encodedHash) {
  if (typeof encodedHash !== 'string') return false;
  const parts = encodedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = parts[1];
  const expected = parts[2];
  const actual = scryptSync(normalizedRecovery, salt, 64).toString('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function issueSessionToken() {
  return randomBytes(48)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function hashSessionToken(rawToken) {
  return createHash('sha256').update(String(rawToken || '')).digest('hex');
}

export function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || '');
  if (!raw) return out;

  raw.split(';').forEach((part) => {
    const [name, ...rest] = part.trim().split('=');
    if (!name) return;
    out[name] = decodeURIComponent(rest.join('=') || '');
  });

  return out;
}

export function readSessionFromRequest(req) {
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
  return cookies[SESSION_COOKIE_NAME] || '';
}

export function buildSessionCookie(rawToken, maxAge = SESSION_MAX_AGE_SECONDS) {
  const secure = process.env.NODE_ENV === 'production';
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    `Max-Age=${Math.max(0, Number(maxAge) || 0)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearSessionCookie() {
  return buildSessionCookie('', 0);
}

export function nowIso() {
  return new Date().toISOString();
}

export function minutesFromNowIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function secondsFromNowIso(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function normalizeRewards(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 8)
    .map((entry, index) => {
      if (typeof entry === 'string') {
        return { title: entry, amount: '' };
      }

      if (entry && typeof entry === 'object') {
        const title =
          typeof entry.title === 'string'
            ? entry.title
            : typeof entry.name === 'string'
            ? entry.name
            : `Reward ${index + 1}`;
        const amount =
          typeof entry.amount === 'string'
            ? entry.amount
            : typeof entry.value === 'string'
            ? entry.value
            : typeof entry.points === 'number'
            ? `${entry.points} pts`
            : typeof entry.points === 'string'
            ? entry.points
            : '';
        return { title, amount };
      }

      return { title: `Reward ${index + 1}`, amount: '' };
    });
}
