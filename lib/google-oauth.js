import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';

const DEFAULT_CLIENT_SECRET_PATH = 'C:\\Users\\funct\\Downloads\\client_secret_60857015250-93sdebpl1pmc120sg29ichtd5q3h98o3.apps.googleusercontent.com.json';
const TOKEN_COOKIE = 'ivucx_google_token';
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
const MAX_IMPORT_BYTES = Number(process.env.GOOGLE_IMPORT_MAX_BYTES || 25 * 1024 * 1024);
const TEXT_PREVIEW_BYTES = Number(process.env.GOOGLE_TEXT_PREVIEW_BYTES || 1024 * 1024);
const DEFAULT_CALLBACK_PATH = '/api/google-auth-callback';

let cachedClientConfig = null;

function sendJson(res, status, payload) {
  res.status(status).json(payload);
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
  const token = encodeURIComponent(encodeBase64Url(JSON.stringify({
    access_token: tokenPayload.access_token,
    expires_at: Date.now() + (Number(tokenPayload.expires_in) || COOKIE_MAX_AGE_SECONDS) * 1000
  })));
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

export function clearGoogleTokenCookie(res) {
  appendSetCookie(res, `${TOKEN_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly`);
}

function setStateCookie(res, nonce) {
  appendSetCookie(res, [
    `${STATE_COOKIE}=${encodeURIComponent(nonce)}`,
    'Max-Age=600',
    'Path=/',
    'SameSite=Lax',
    'HttpOnly'
  ].join('; '));
}

function clearStateCookie(res) {
  appendSetCookie(res, `${STATE_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly`);
}

export function getGoogleAccessToken(req) {
  const raw = parseCookies(req)[TOKEN_COOKIE];
  if (!raw) return '';
  try {
    const parsed = JSON.parse(decodeBase64Url(raw));
    if (!parsed || !parsed.access_token) return '';
    if (Number(parsed.expires_at) && Date.now() > Number(parsed.expires_at) - 30000) return '';
    return String(parsed.access_token);
  } catch (err) {
    return '';
  }
}

export async function getGoogleIdentity(req) {
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
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        authenticated: true,
        accessToken,
        accountId: 'Google account',
        email: '',
        name: ''
      };
    }

    const email = typeof payload.email === 'string' ? payload.email : '';
    const name = typeof payload.name === 'string' ? payload.name : '';
    return {
      authenticated: true,
      accessToken,
      accountId: email || name || 'Google account',
      email,
      name
    };
  } catch (err) {
    return {
      authenticated: true,
      accessToken,
      accountId: 'Google account',
      email: '',
      name: ''
    };
  }
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

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({}));
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
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const payload = await response.json().catch(() => ({}));
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
  const response = await fetch(target.url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

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

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMPORT_BYTES) {
    return {
      title: metadata.name || target.title,
      kind: inferKind(metadata.name, metadata.mimeType),
      ext: getExtension(metadata.name),
      mime: metadata.mimeType || target.mime,
      size: buffer.length,
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
    sendJson(res, 200, {
      configured: true,
      authenticated: !!getGoogleAccessToken(req),
      clientType: client.type,
      redirectUri
    });
  } catch (err) {
    sendJson(res, 200, {
      configured: false,
      authenticated: false,
      error: formatConfigurationError(err)
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
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state
    });
    const loginHint = normalizeLoginHint(req.query.login_hint || req.query.email);
    if (loginHint) {
      params.set('login_hint', loginHint);
    }
    setStateCookie(res, nonce);
    res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    sendJson(res, 500, {
      error: formatConfigurationError(err)
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
    const returnTo = safeReturnTo(state.returnTo);
    const separator = returnTo.includes('?') ? '&' : '?';
    res.redirect(302, `${returnTo}${separator}googleConnected=${encodeURIComponent(state.kind || 'drive')}`);
  } catch (err) {
    clearGoogleTokenCookie(res);
    sendJson(res, 500, {
      error: err && err.message ? err.message : 'Google authorization failed.'
    });
  }
}

export async function googleFilesHandler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const accessToken = getGoogleAccessToken(req);
  if (!accessToken) {
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
      error: err && err.message ? err.message : 'Google file list failed.'
    });
  }
}

export async function googleImportHandler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  const accessToken = getGoogleAccessToken(req);
  if (!accessToken) {
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
      error: err && err.message ? err.message : 'Google import failed.'
    });
  }
}
