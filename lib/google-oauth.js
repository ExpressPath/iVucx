import { createHmac, randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

import { readBoundedResponseBuffer, readBoundedResponseText } from './bounded-response.js';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { secureStringEqual } from './secure-compare.js';

const DEFAULT_CLIENT_SECRET_PATH = path.join(homedir(), '.ivucx', 'secrets', 'google-oauth-client.json');
const TOKEN_COOKIE = 'ivucx_google_token';
const IDENTITY_COOKIE = 'ivucx_google_identity';
const STATE_COOKIE = 'ivucx_google_state';
const COOKIE_MAX_AGE_SECONDS = 55 * 60;
const IDENTITY_SCOPE = [
  'openid',
  'email',
  'profile'
].join(' ');
const DRIVE_SCOPE = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.readonly'
].join(' ');
const DRIVE_SCOPE_VALUE = 'https://www.googleapis.com/auth/drive.readonly';
const MAX_IMPORT_BYTES = Math.max(1024 * 1024, Number(process.env.GOOGLE_IMPORT_MAX_BYTES) || 25 * 1024 * 1024);
const TEXT_PREVIEW_BYTES = Math.max(65536, Number(process.env.GOOGLE_TEXT_PREVIEW_BYTES) || 1024 * 1024);
const DEFAULT_CALLBACK_PATH = '/api/google-auth-callback';
const GOOGLE_REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.GOOGLE_REQUEST_TIMEOUT_MS) || 20000);
const GOOGLE_DOWNLOAD_TIMEOUT_MS = Math.max(10000, Number(process.env.GOOGLE_DOWNLOAD_TIMEOUT_MS) || 60000);
const GOOGLE_JSON_MAX_BYTES = Math.max(65536, Number(process.env.GOOGLE_JSON_MAX_BYTES) || 2 * 1024 * 1024);

let cachedClientConfig = null;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

async function fetchGoogleResponse(url, options = {}, maxBytes = GOOGLE_JSON_MAX_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await readBoundedResponseText(response, maxBytes);
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      payload = {};
    }
    return { response, payload };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeout = new Error('Google request timed out.');
      timeout.statusCode = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function appendSetCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookie);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie]);
    return;
  }
  res.setHeader('Set-Cookie', [current, cookie]);
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function hmacBase64Url(value, secret) {
  return createHmac('sha256', secret)
    .update(String(value || ''))
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function safeReturnTo(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !text.startsWith('/') || text.startsWith('//') || /[\r\n]/.test(text)) {
    return '/Vucks.html';
  }
  return text;
}

function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function getConfiguredPublicBaseUrl() {
  const raw = process.env.GOOGLE_PUBLIC_BASE_URL
    || process.env.IVUCX_PUBLIC_BASE_URL
    || process.env.PUBLIC_BASE_URL
    || process.env.APP_PUBLIC_BASE_URL
    || '';
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/g, '');
}

function getRedirectUri(req, client) {
  const explicit = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (explicit) {
    return explicit;
  }
  const publicBaseUrl = getConfiguredPublicBaseUrl();
  if (publicBaseUrl) {
    return `${publicBaseUrl}${DEFAULT_CALLBACK_PATH}`;
  }
  const current = `${getOrigin(req)}${DEFAULT_CALLBACK_PATH}`;
  const redirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
  if (redirects.includes(current)) return current;
  return current;
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}

function assertCompatibleRedirect(req, client) {
  const redirectUri = getRedirectUri(req, client);
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch (err) {
    throw new Error(`Google OAuth redirect URI is invalid: ${redirectUri}`);
  }

  if (client.type === 'installed' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('The configured Google OAuth file is a Desktop client. Use it only for localhost, or set GOOGLE_CLIENT_SECRET_JSON / GOOGLE_CLIENT_SECRET_BASE64 / GOOGLE_CLIENT_SECRET_PATH to a Web application OAuth client for this server.');
  }

  if (client.type === 'web') {
    const redirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (redirects.length && !redirects.includes(redirectUri)) {
      throw new Error(`Google OAuth redirect URI is not registered for this Web client: ${redirectUri}`);
    }
  }

  return redirectUri;
}

function formatConfigurationError(error) {
  const message = error && error.message ? error.message : 'Google OAuth is not configured.';
  if (error && (error.code === 'ENOENT' || /no such file or directory/i.test(message))) {
    return 'Google OAuth client secret file was not found. Set GOOGLE_CLIENT_SECRET_JSON, GOOGLE_CLIENT_SECRET_BASE64, or GOOGLE_CLIENT_SECRET_PATH.';
  }
  if (/client_secret/i.test(message) && /json/i.test(message) && /unexpected/i.test(message)) {
    return 'Google OAuth client secret JSON could not be parsed.';
  }
  return message;
}

function getOAuthScope(kind) {
  return String(kind || '').trim().toLowerCase() === 'blue'
    ? IDENTITY_SCOPE
    : DRIVE_SCOPE;
}

function isIdentityOnlyKind(kind) {
  return String(kind || '').trim().toLowerCase() === 'blue';
}

function normalizeLoginHint(value) {
  const hint = String(value || '').trim();
  if (!hint || /[\r\n]/.test(hint)) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint) ? hint : '';
}

async function loadClientConfig() {
  if (cachedClientConfig) return cachedClientConfig;

  let raw = process.env.GOOGLE_CLIENT_SECRET_JSON || '';
  if (!raw && process.env.GOOGLE_CLIENT_SECRET_BASE64) {
    raw = Buffer.from(process.env.GOOGLE_CLIENT_SECRET_BASE64, 'base64').toString('utf8');
  }
  if (!raw) {
    const path = process.env.GOOGLE_CLIENT_SECRET_PATH || DEFAULT_CLIENT_SECRET_PATH;
    raw = await readFile(path, 'utf8');
  }

  const parsed = JSON.parse(raw);
  const client = parsed.web || parsed.installed || parsed;
  if (!client || !client.client_id) {
    throw new Error('Google OAuth client_id is missing.');
  }

  cachedClientConfig = {
    client_id: client.client_id,
    client_secret: client.client_secret || '',
    redirect_uris: Array.isArray(client.redirect_uris) ? client.redirect_uris : [],
    type: parsed.web ? 'web' : (parsed.installed ? 'installed' : 'unknown')
  };
  return cachedClientConfig;
}

function setTokenCookie(req, res, tokenPayload) {
  const secret = getCookieSecret(cachedClientConfig);
  if (!secret) {
    const error = new Error('Google token cookie signing secret is missing.');
    error.statusCode = 500;
    throw error;
  }
  const payload = encodeBase64Url(JSON.stringify({
    access_token: tokenPayload.access_token,
    scope: tokenPayload.scope || '',
    expires_at: Date.now() + (Number(tokenPayload.expires_in) || COOKIE_MAX_AGE_SECONDS) * 1000
  }));
  const token = encodeURIComponent(`${payload}.${hmacBase64Url(payload, secret)}`);
  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const cookie = [
    `${TOKEN_COOKIE}=${token}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
  appendSetCookie(res, cookie);
}

function getCookieSecret(client = null) {
  let jsonClientSecret = '';
  const rawJson = String(process.env.GOOGLE_CLIENT_SECRET_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      const config = parsed && (parsed.web || parsed.installed || parsed);
      jsonClientSecret = String(config && config.client_secret || '').trim();
    } catch (error) {
      jsonClientSecret = '';
    }
  }
  return String(
    process.env.GOOGLE_IDENTITY_COOKIE_SECRET
    || (client && client.client_secret)
    || process.env.GOOGLE_CLIENT_SECRET
    || jsonClientSecret
    || ''
  ).trim();
}

function setIdentityCookie(res, identity, client) {
  const secret = getCookieSecret(client);
  if (!secret) {
    const error = new Error('Google identity cookie signing secret is missing.');
    error.statusCode = 500;
    throw error;
  }

  const expiresAt = Number(identity && identity.expires_at) || Date.now() + COOKIE_MAX_AGE_SECONDS * 1000;
  const maxAge = Math.max(60, Math.min(COOKIE_MAX_AGE_SECONDS, Math.floor((expiresAt - Date.now()) / 1000)));
  const payload = encodeBase64Url(JSON.stringify({
    sub: String(identity.sub || ''),
    email: String(identity.email || ''),
    name: String(identity.name || ''),
    picture: String(identity.picture || ''),
    expires_at: expiresAt
  }));
  const signature = hmacBase64Url(payload, secret);
  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const cookie = [
    `${IDENTITY_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
  appendSetCookie(res, cookie);
}

export function clearGoogleTokenCookie(res) {
  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? '; Secure' : '';
  appendSetCookie(res, `${TOKEN_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure}`);
  appendSetCookie(res, `${IDENTITY_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure}`);
}

function setStateCookie(res, nonce) {
  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  appendSetCookie(res, [
    `${STATE_COOKIE}=${encodeURIComponent(nonce)}`,
    'Max-Age=600',
    'Path=/',
    'SameSite=Lax',
    'HttpOnly',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; '));
}

function clearStateCookie(res) {
  const secure = String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? '; Secure' : '';
  appendSetCookie(res, `${STATE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${secure}`);
}

function getGoogleTokenPayload(req) {
  const raw = parseCookies(req)[TOKEN_COOKIE];
  if (!raw || !raw.includes('.')) return null;
  try {
    const secret = getCookieSecret(cachedClientConfig);
    if (!secret) return null;
    const [payload, signature] = String(raw).split('.');
    if (!payload || !signature) return null;
    const expected = hmacBase64Url(payload, secret);
    if (!secureStringEqual(signature, expected)) {
      return null;
    }
    const parsed = JSON.parse(decodeBase64Url(payload));
    if (!parsed || !parsed.access_token) return null;
    if (Number(parsed.expires_at) && Date.now() > Number(parsed.expires_at) - 30000) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

async function getGoogleIdentityPayload(req) {
  const raw = parseCookies(req)[IDENTITY_COOKIE];
  if (!raw || !raw.includes('.')) return null;
  try {
    const client = await loadClientConfig();
    const secret = getCookieSecret(client);
    if (!secret) return null;
    const [payload, signature] = String(raw).split('.');
    if (!payload || !signature) return null;
    const expected = hmacBase64Url(payload, secret);
    if (!secureStringEqual(signature, expected)) {
      return null;
    }
    const parsed = JSON.parse(decodeBase64Url(payload));
    if (!parsed || !parsed.sub) return null;
    if (Number(parsed.expires_at) && Date.now() > Number(parsed.expires_at) - 30000) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

export function getGoogleAccessToken(req) {
  const payload = getGoogleTokenPayload(req);
  return payload ? String(payload.access_token || '') : '';
}

function hasGoogleDriveScope(req) {
  const payload = getGoogleTokenPayload(req);
  const scopes = String(payload && payload.scope || '').split(/\s+/).filter(Boolean);
  return scopes.includes(DRIVE_SCOPE_VALUE);
}

export async function getGoogleIdentity(req) {
  const storedIdentity = await getGoogleIdentityPayload(req);
  if (storedIdentity) {
    const email = typeof storedIdentity.email === 'string' ? storedIdentity.email : '';
    const name = typeof storedIdentity.name === 'string' ? storedIdentity.name : '';
    return {
      authenticated: true,
      accessToken: getGoogleAccessToken(req),
      accountId: String(storedIdentity.sub || ''),
      email,
      name
    };
  }

  const accessToken = getGoogleAccessToken(req);
  if (!accessToken) {
    return {
      authenticated: false,
      accessToken: '',
      accountId: '',
      email: '',
      name: ''
    };
  }

  try {
    const { response, payload } = await fetchGoogleResponse('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      return {
        authenticated: false,
        accessToken: '',
        accountId: '',
        email: '',
        name: ''
      };
    }

    const email = typeof payload.email === 'string' ? payload.email : '';
    const name = typeof payload.name === 'string' ? payload.name : '';
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) {
      return {
        authenticated: false,
        accessToken: '',
        accountId: '',
        email: '',
        name: ''
      };
    }
    return {
      authenticated: true,
      accessToken,
      accountId: subject,
      email,
      name
    };
  } catch (err) {
    return {
      authenticated: false,
      accessToken: '',
      accountId: '',
      email: '',
      name: ''
    };
  }
}

async function verifyGoogleOneTapCredential(credential) {
  const token = String(credential || '').trim();
  if (!token) {
    const error = new Error('Google credential is missing.');
    error.statusCode = 400;
    throw error;
  }

  const client = await loadClientConfig();
  const params = new URLSearchParams({ id_token: token });
  const { response, payload } = await fetchGoogleResponse(`https://oauth2.googleapis.com/tokeninfo?${params.toString()}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || 'Google One Tap credential verification failed.');
    error.statusCode = 401;
    throw error;
  }
  if (String(payload.aud || '') !== client.client_id) {
    const error = new Error('Google credential audience does not match this app.');
    error.statusCode = 401;
    throw error;
  }
  if (!String(payload.sub || '').trim() || !['accounts.google.com', 'https://accounts.google.com'].includes(String(payload.iss || ''))) {
    const error = new Error('Google credential issuer or subject is invalid.');
    error.statusCode = 401;
    throw error;
  }
  const expiresAt = Number(payload.exp || 0) * 1000;
  if (!expiresAt || Date.now() > expiresAt - 30000) {
    const error = new Error('Google credential is expired.');
    error.statusCode = 401;
    throw error;
  }
  if (payload.email && String(payload.email_verified || '').toLowerCase() !== 'true') {
    const error = new Error('Google account email is not verified.');
    error.statusCode = 401;
    throw error;
  }

  return {
    client,
    identity: {
      sub: String(payload.sub || ''),
      email: String(payload.email || ''),
      name: String(payload.name || ''),
      picture: String(payload.picture || ''),
      expires_at: expiresAt
    }
  };
}

async function exchangeCodeForToken(req, code) {
  const client = await loadClientConfig();
  const redirectUri = assertCompatibleRedirect(req, client);
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });
  if (client.client_secret) {
    body.set('client_secret', client.client_secret);
  }

  const { response, payload } = await fetchGoogleResponse('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Google token exchange failed.');
  }
  return payload;
}

function getKindQuery(kind) {
  switch (kind) {
    case 'slides':
      return "trashed = false and mimeType = 'application/vnd.google-apps.presentation'";
    case 'sheets':
      return "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'";
    case 'docs':
      return "trashed = false and mimeType = 'application/vnd.google-apps.document'";
    default:
      return "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  }
}

async function fetchGoogleJson(url, accessToken) {
  const { response, payload } = await fetchGoogleResponse(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'Google request failed.';
    throw new Error(message);
  }
  return payload;
}

function inferKind(name, mime) {
  const ext = getExtension(name);
  const type = String(mime || '').toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/') || ['txt', 'md', 'markdown', 'json', 'csv'].includes(ext)) return 'text';
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'presentation';
  if (['doc', 'docx'].includes(ext)) return 'document';
  if (['xls', 'xlsx'].includes(ext)) return 'spreadsheet';
  return 'file';
}

function getExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function exportedName(name, ext) {
  const clean = String(name || 'Google file').trim() || 'Google file';
  return /\.[a-z0-9]+$/i.test(clean) ? clean : `${clean}.${ext}`;
}

function resolveDownloadTarget(metadata) {
  const mime = String(metadata.mimeType || '');
  if (mime === 'application/vnd.google-apps.presentation') {
    return {
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(metadata.id)}/export?mimeType=application/pdf`,
      mime: 'application/pdf',
      ext: 'pdf',
      title: exportedName(metadata.name, 'pdf')
    };
  }
  if (mime === 'application/vnd.google-apps.document') {
    return {
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(metadata.id)}/export?mimeType=application/pdf`,
      mime: 'application/pdf',
      ext: 'pdf',
      title: exportedName(metadata.name, 'pdf')
    };
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return {
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(metadata.id)}/export?mimeType=application/pdf`,
      mime: 'application/pdf',
      ext: 'pdf',
      title: exportedName(metadata.name, 'pdf')
    };
  }
  return {
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(metadata.id)}?alt=media`,
    mime: mime || 'application/octet-stream',
    ext: getExtension(metadata.name),
    title: metadata.name || 'Google file'
  };
}

async function downloadGoogleFile(metadata, accessToken) {
  const target = resolveDownloadTarget(metadata);
  const declaredSize = Number(metadata.size) || 0;
  if (declaredSize > MAX_IMPORT_BYTES) {
    return {
      title: metadata.name || target.title,
      kind: inferKind(metadata.name, metadata.mimeType),
      ext: getExtension(metadata.name),
      mime: metadata.mimeType || target.mime,
      size: declaredSize,
      url: '',
      text: '',
      webViewLink: metadata.webViewLink || '',
      googleFileId: metadata.id,
      importedAt: new Date().toISOString()
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_DOWNLOAD_TIMEOUT_MS);
  let response;
  let buffer;
  try {
    response = await fetch(target.url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (response.ok) {
      buffer = await readBoundedResponseBuffer(response, MAX_IMPORT_BYTES);
    }
  } catch (error) {
    if (error && error.code === 'UPSTREAM_RESPONSE_TOO_LARGE') {
      return {
        title: metadata.name || target.title,
        kind: inferKind(metadata.name, metadata.mimeType),
        ext: getExtension(metadata.name),
        mime: metadata.mimeType || target.mime,
        size: Math.max(declaredSize, MAX_IMPORT_BYTES + 1),
        url: '',
        text: '',
        webViewLink: metadata.webViewLink || '',
        googleFileId: metadata.id,
        importedAt: new Date().toISOString()
      };
    }
    if (error && error.name === 'AbortError') {
      const timeout = new Error('Google file download timed out.');
      timeout.statusCode = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      title: metadata.name || target.title,
      kind: inferKind(metadata.name, metadata.mimeType),
      ext: getExtension(metadata.name),
      mime: metadata.mimeType || '',
      size: Number(metadata.size) || 0,
      url: '',
      text: '',
      webViewLink: metadata.webViewLink || '',
      googleFileId: metadata.id,
      importedAt: new Date().toISOString()
    };
  }

  const finalMime = target.mime || response.headers.get('content-type') || 'application/octet-stream';
  const kind = inferKind(target.title, finalMime);
  const text = kind === 'text' && buffer.length <= TEXT_PREVIEW_BYTES
    ? buffer.toString('utf8')
    : '';

  return {
    title: target.title,
    kind,
    ext: target.ext || getExtension(target.title),
    mime: finalMime,
    size: buffer.length,
    url: `data:${finalMime};base64,${buffer.toString('base64')}`,
    text,
    webViewLink: metadata.webViewLink || '',
    googleFileId: metadata.id,
    importedAt: new Date().toISOString()
  };
}

export async function googleStatusHandler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    const client = await loadClientConfig();
    const redirectUri = assertCompatibleRedirect(req, client);
    const identity = await getGoogleIdentity(req);
    sendJson(res, 200, {
      configured: true,
      authenticated: !!identity.authenticated,
      clientId: client.client_id,
      clientType: client.type,
      redirectUri
    });
  } catch (err) {
    sendJson(res, 200, {
      configured: false,
      authenticated: false,
      error: process.env.NODE_ENV === 'production'
        ? 'Google sign-in is not configured.'
        : formatConfigurationError(err)
    });
  }
}

export async function googleOneTapHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    await assertDistributedRateLimit(req, {
      route: 'google-one-tap',
      limit: 20,
      windowSeconds: 60
    });
    const body = req.body || {};
    const credential = typeof body.credential === 'string' ? body.credential : '';
    const { client, identity } = await verifyGoogleOneTapCredential(credential);
    setIdentityCookie(res, identity, client);
    sendJson(res, 200, {
      loggedIn: true,
      accountId: identity.email || identity.name || 'Google account',
      email: identity.email,
      name: identity.name,
      rewards: [],
      provider: 'google-one-tap',
      reason: 'ok'
    });
  } catch (err) {
    if (err && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    const status = getHttpErrorStatus(err);
    sendJson(res, status, {
      error: getPublicErrorMessage(err, 'Google One Tap login failed.', status)
    });
  }
}

export async function googleAuthStartHandler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    const client = await loadClientConfig();
    const kind = String(req.query.kind || 'drive').trim() || 'drive';
    const nonce = randomUUID();
    const state = encodeBase64Url(JSON.stringify({
      nonce,
      kind,
      returnTo: safeReturnTo(req.query.returnTo)
    }));
    const redirectUri = assertCompatibleRedirect(req, client);
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: getOAuthScope(kind),
      state
    });
    if (isIdentityOnlyKind(kind)) {
      params.set('prompt', 'select_account');
    } else {
      params.set('access_type', 'offline');
      params.set('include_granted_scopes', 'true');
      params.set('prompt', 'consent');
    }
    const loginHint = normalizeLoginHint(req.query.login_hint || req.query.email);
    if (loginHint) {
      params.set('login_hint', loginHint);
    }
    setStateCookie(res, nonce);
    res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    sendJson(res, 500, {
      error: process.env.NODE_ENV === 'production'
        ? 'Google authorization is temporarily unavailable.'
        : formatConfigurationError(err)
    });
  }
}

export async function googleAuthCallbackHandler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  let state = { returnTo: '/Vucks.html', kind: 'drive' };
  try {
    if (req.query.state) {
      state = {
        ...state,
        ...JSON.parse(decodeBase64Url(req.query.state))
      };
    }
  } catch (err) {
    // keep safe defaults
  }
  const stateCookie = parseCookies(req)[STATE_COOKIE] || '';
  clearStateCookie(res);
  if (!state.nonce || !stateCookie || stateCookie !== state.nonce) {
    clearGoogleTokenCookie(res);
    sendJson(res, 400, { error: 'Invalid Google OAuth state.' });
    return;
  }

  if (req.query.error) {
    const returnTo = safeReturnTo(state.returnTo);
    const separator = returnTo.includes('?') ? '&' : '?';
    res.redirect(302, `${returnTo}${separator}googleError=${encodeURIComponent(String(req.query.error))}`);
    return;
  }

  try {
    const code = String(req.query.code || '');
    if (!code) {
      throw new Error('Google authorization code is missing.');
    }
    const token = await exchangeCodeForToken(req, code);
    setTokenCookie(req, res, token);
    try {
      const { response, payload } = await fetchGoogleResponse('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${safeString(token.access_token)}` }
      });
      if (response.ok && safeString(payload && payload.sub)) {
        const client = await loadClientConfig();
        setIdentityCookie(res, {
          sub: safeString(payload.sub),
          email: safeString(payload.email),
          name: safeString(payload.name),
          picture: safeString(payload.picture),
          expires_at: Date.now() + (Number(token.expires_in) || COOKIE_MAX_AGE_SECONDS) * 1000
        }, client);
      }
    } catch (identityError) {
      // The signed access-token cookie can still establish identity on the next request.
    }
    const returnTo = safeReturnTo(state.returnTo);
    const separator = returnTo.includes('?') ? '&' : '?';
    res.redirect(302, `${returnTo}${separator}googleConnected=${encodeURIComponent(state.kind || 'drive')}`);
  } catch (err) {
    clearGoogleTokenCookie(res);
    sendJson(res, 500, {
      error: getPublicErrorMessage(err, 'Google authorization failed.', 500)
    });
  }
}

export async function googleFilesHandler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    await assertDistributedRateLimit(req, {
      route: 'google-files',
      limit: 60,
      windowSeconds: 60
    });
  } catch (err) {
    if (err && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    const status = getHttpErrorStatus(err, 503);
    sendJson(res, status, { error: getPublicErrorMessage(err, 'Google request protection is unavailable.', status) });
    return;
  }
  const accessToken = getGoogleAccessToken(req);
  if (!accessToken || !hasGoogleDriveScope(req)) {
    sendJson(res, 401, { error: 'Google authorization required.', needsAuth: true });
    return;
  }
  try {
    const kind = String(req.query.kind || 'drive').trim() || 'drive';
    const params = new URLSearchParams({
      q: getKindQuery(kind),
      pageSize: '30',
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink)'
    });
    const payload = await fetchGoogleJson(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, accessToken);
    sendJson(res, 200, {
      files: Array.isArray(payload.files) ? payload.files : []
    });
  } catch (err) {
    sendJson(res, 502, {
      error: getPublicErrorMessage(err, 'Google file list failed.', 502)
    });
  }
}

export async function googleImportHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    await assertDistributedRateLimit(req, {
      route: 'google-import',
      limit: 20,
      windowSeconds: 60
    });
  } catch (err) {
    if (err && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    const status = getHttpErrorStatus(err, 503);
    sendJson(res, status, { error: getPublicErrorMessage(err, 'Google request protection is unavailable.', status) });
    return;
  }
  const accessToken = getGoogleAccessToken(req);
  if (!accessToken || !hasGoogleDriveScope(req)) {
    sendJson(res, 401, { error: 'Google authorization required.', needsAuth: true });
    return;
  }
  try {
    const body = req.body || {};
    const fileId = String(body.fileId || '').trim();
    if (!fileId) {
      sendJson(res, 400, { error: 'fileId is required.' });
      return;
    }
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,size,webViewLink'
    });
    const metadata = await fetchGoogleJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      accessToken
    );
    const upload = await downloadGoogleFile(metadata, accessToken);
    sendJson(res, 200, {
      upload: {
        id: randomUUID(),
        source: 'google',
        provider: 'google',
        providerKind: String(body.kind || 'drive'),
        ...upload
      }
    });
  } catch (err) {
    sendJson(res, 502, {
      error: getPublicErrorMessage(err, 'Google import failed.', 502)
    });
  }
}
