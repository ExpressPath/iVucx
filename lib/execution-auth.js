import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signWithKey,
  verify as verifyWithKey
} from 'node:crypto';
import { readFile } from 'fs/promises';
import { isAbsolute, resolve as resolvePath } from 'path';

import { secureStringEqual } from './secure-compare.js';

export const EXECUTION_SIGNATURE_HEADERS = Object.freeze({
  algorithm: 'x-ivucx-execution-signature-algorithm',
  keyId: 'x-ivucx-execution-key-id',
  nonce: 'x-ivucx-execution-nonce',
  signature: 'x-ivucx-execution-signature',
  timestamp: 'x-ivucx-execution-timestamp'
});

const SIGNATURE_ALGORITHM = 'rsa-sha256';
const DEFAULT_SIGNATURE_MAX_AGE_MS = 2 * 60 * 1000;
const DEFAULT_SIGNATURE_MAX_FUTURE_MS = 30 * 1000;
const DEFAULT_REPLAY_CACHE_MAX = 10000;
const PRIVATE_KEY_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PRIVATE_KEY',
  'EXECUTION_SERVER_PRIVATE_KEY',
  'ORACLE_SERVER_PRIVATE_KEY',
  'EXECUTION_PRIVATE_KEY'
]);
const PRIVATE_KEY_PATH_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PRIVATE_KEY_PATH',
  'EXECUTION_SERVER_PRIVATE_KEY_PATH',
  'ORACLE_SERVER_PRIVATE_KEY_PATH',
  'EXECUTION_PRIVATE_KEY_PATH'
]);
const KEY_ID_ENV_NAMES = Object.freeze([
  'EXECUTION_API_KEY_ID',
  'EXECUTION_SERVER_KEY_ID',
  'ORACLE_SERVER_KEY_ID',
  'EXECUTION_KEY_ID'
]);
const SIGNATURE_ENABLED_ENV_NAMES = Object.freeze([
  'EXECUTION_SIGNATURE_ENABLED',
  'EXECUTION_API_SIGNATURE_ENABLED',
  'EXECUTION_SERVER_SIGNATURE_ENABLED',
  'ORACLE_SERVER_SIGNATURE_ENABLED'
]);
const PUBLIC_KEY_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PUBLIC_KEY',
  'EXECUTION_SERVER_PUBLIC_KEY',
  'ORACLE_SERVER_PUBLIC_KEY',
  'EXECUTION_PUBLIC_KEY'
]);
const PUBLIC_KEY_PATH_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PUBLIC_KEY_PATH',
  'EXECUTION_SERVER_PUBLIC_KEY_PATH',
  'ORACLE_SERVER_PUBLIC_KEY_PATH',
  'EXECUTION_PUBLIC_KEY_PATH'
]);
const PUBLIC_KEYS_JSON_ENV_NAMES = Object.freeze([
  'EXECUTION_API_PUBLIC_KEYS_JSON',
  'EXECUTION_SERVER_PUBLIC_KEYS_JSON',
  'EXECUTION_PUBLIC_KEYS_JSON'
]);

let cachedPrivateKeyPromise = null;
let cachedPublicKeysPromise = null;
const replayNonces = new Map();

function firstConfiguredEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

function normalizePem(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

function resolveKeyPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

async function loadPrivateKeyPem() {
  const inlinePem = normalizePem(firstConfiguredEnv(PRIVATE_KEY_ENV_NAMES));
  if (inlinePem) {
    return inlinePem;
  }

  const filePath = resolveKeyPath(firstConfiguredEnv(PRIVATE_KEY_PATH_ENV_NAMES));
  if (!filePath) {
    return '';
  }

  const fileText = await readFile(filePath, 'utf8');
  return normalizePem(fileText);
}

async function getPrivateKeyPem() {
  if (!cachedPrivateKeyPromise) {
    cachedPrivateKeyPromise = loadPrivateKeyPem().catch((error) => {
      cachedPrivateKeyPromise = null;
      throw error;
    });
  }
  return cachedPrivateKeyPromise;
}

function buildBodyDigest(bodyText) {
  return createHash('sha256').update(String(bodyText || ''), 'utf8').digest('hex');
}

function normalizeTargetPath(targetPath) {
  const raw = String(targetPath || '').trim();
  if (!raw) {
    return '/';
  }

  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    return `${parsed.pathname || '/'}${parsed.search || ''}`;
  }

  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildSigningMessage({ bodyText, method, nonce, targetPath, timestamp }) {
  return [
    String(timestamp || '').trim(),
    String(nonce || '').trim(),
    String(method || 'GET').trim().toUpperCase(),
    normalizeTargetPath(targetPath),
    buildBodyDigest(bodyText)
  ].join('\n');
}

function derivePublicKeyId(publicKey) {
  const keyObject = createPublicKey(publicKey);
  const publicKeyDer = keyObject.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 24);
}

function deriveKeyId(privateKeyPem) {
  const configuredKeyId = firstConfiguredEnv(KEY_ID_ENV_NAMES);
  if (configuredKeyId) {
    return configuredKeyId;
  }

  if (!privateKeyPem) {
    return '';
  }

  try {
    return derivePublicKeyId(createPrivateKey(privateKeyPem));
  } catch (_error) {
    return createHash('sha256').update(privateKeyPem, 'utf8').digest('hex').slice(0, 24);
  }
}

async function getExecutionSigningConfig() {
  const privateKeyPem = await getPrivateKeyPem();
  const explicitSetting = firstConfiguredEnv(SIGNATURE_ENABLED_ENV_NAMES);
  const enabled = parseBoolean(explicitSetting, !!privateKeyPem);

  if (!enabled) {
    return {
      enabled: false,
      keyId: ''
    };
  }

  if (!privateKeyPem) {
    const error = new Error(
      'Execution request signing is enabled but no private key is configured. Set EXECUTION_API_PRIVATE_KEY or EXECUTION_API_PRIVATE_KEY_PATH.'
    );
    error.statusCode = 500;
    throw error;
  }

  return {
    enabled: true,
    keyId: deriveKeyId(privateKeyPem),
    privateKeyPem
  };
}

function normalizeKeyMap(value) {
  const result = new Map();
  if (value instanceof Map) {
    for (const [keyId, publicKeyPem] of value.entries()) {
      if (String(keyId || '').trim() && String(publicKeyPem || '').trim()) {
        result.set(String(keyId).trim(), normalizePem(publicKeyPem));
      }
    }
    return result;
  }
  for (const [keyId, publicKeyPem] of Object.entries(value || {})) {
    if (String(keyId || '').trim() && String(publicKeyPem || '').trim()) {
      result.set(String(keyId).trim(), normalizePem(publicKeyPem));
    }
  }
  return result;
}

async function loadPublicKeys() {
  const configured = firstConfiguredEnv(PUBLIC_KEYS_JSON_ENV_NAMES);
  const keys = new Map();
  if (configured) {
    let parsed;
    try {
      parsed = JSON.parse(configured);
    } catch (_error) {
      throw new Error('EXECUTION_API_PUBLIC_KEYS_JSON must be a JSON object keyed by key id.');
    }
    const parsedKeys = normalizeKeyMap(parsed);
    if (!parsedKeys.size || parsedKeys.size > 16) {
      throw new Error('EXECUTION_API_PUBLIC_KEYS_JSON must contain between 1 and 16 public keys.');
    }
    for (const [keyId, publicKeyPem] of parsedKeys) keys.set(keyId, publicKeyPem);
  }

  let singlePublicKey = normalizePem(firstConfiguredEnv(PUBLIC_KEY_ENV_NAMES));
  const publicKeyPath = resolveKeyPath(firstConfiguredEnv(PUBLIC_KEY_PATH_ENV_NAMES));
  if (!singlePublicKey && publicKeyPath) {
    singlePublicKey = normalizePem(await readFile(publicKeyPath, 'utf8'));
  }
  if (singlePublicKey) {
    const keyId = firstConfiguredEnv(KEY_ID_ENV_NAMES) || derivePublicKeyId(singlePublicKey);
    keys.set(keyId, singlePublicKey);
  }

  for (const publicKeyPem of keys.values()) {
    createPublicKey(publicKeyPem);
  }
  return keys;
}

async function getExecutionPublicKeys() {
  if (!cachedPublicKeysPromise) {
    cachedPublicKeysPromise = loadPublicKeys().catch((error) => {
      cachedPublicKeysPromise = null;
      throw error;
    });
  }
  return cachedPublicKeysPromise;
}

function headerValue(headers, name) {
  const value = headers && headers[name];
  if (Array.isArray(value)) return headerValue({ [name]: value[0] }, name);
  return typeof value === 'string' ? value.trim() : '';
}

function createAuthError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = statusCode === 503 ? 'EXECUTION_AUTH_CONFIGURATION_ERROR' : 'EXECUTION_AUTH_REJECTED';
  return error;
}

function pruneReplayNonces(store, nowMs, maxEntries) {
  for (const [key, expiresAt] of store.entries()) {
    if (!(Number(expiresAt) > nowMs)) store.delete(key);
  }
  while (store.size >= maxEntries) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) break;
    store.delete(oldestKey);
  }
}

export async function attachExecutionRequestAuthHeaders({
  bodyText = '',
  headers = {},
  keyId = '',
  method = 'GET',
  nonce = '',
  privateKeyPem = '',
  targetPath = '/',
  timestamp = ''
}) {
  const signing = privateKeyPem
    ? {
        enabled: true,
        keyId: String(keyId || '').trim() || derivePublicKeyId(createPrivateKey(normalizePem(privateKeyPem))),
        privateKeyPem: normalizePem(privateKeyPem)
      }
    : await getExecutionSigningConfig();
  if (!signing.enabled) {
    return headers;
  }

  const signedAt = String(timestamp || '').trim() || new Date().toISOString();
  const requestNonce = String(nonce || '').trim() || randomBytes(24).toString('base64url');
  const message = buildSigningMessage({
    bodyText,
    method,
    nonce: requestNonce,
    targetPath,
    timestamp: signedAt
  });

  const signature = signWithKey('RSA-SHA256', Buffer.from(message, 'utf8'), signing.privateKeyPem).toString('base64');
  return {
    ...headers,
    [EXECUTION_SIGNATURE_HEADERS.algorithm]: SIGNATURE_ALGORITHM,
    [EXECUTION_SIGNATURE_HEADERS.keyId]: signing.keyId,
    [EXECUTION_SIGNATURE_HEADERS.nonce]: requestNonce,
    [EXECUTION_SIGNATURE_HEADERS.signature]: signature,
    [EXECUTION_SIGNATURE_HEADERS.timestamp]: signedAt
  };
}

export function verifyExecutionRequestSignature({
  bodyText = '',
  headers = {},
  maxAgeMs = DEFAULT_SIGNATURE_MAX_AGE_MS,
  maxFutureMs = DEFAULT_SIGNATURE_MAX_FUTURE_MS,
  method = 'GET',
  nowMs = Date.now(),
  publicKeys,
  replayStore = replayNonces,
  targetPath = '/'
}) {
  const algorithm = headerValue(headers, EXECUTION_SIGNATURE_HEADERS.algorithm);
  const keyId = headerValue(headers, EXECUTION_SIGNATURE_HEADERS.keyId);
  const nonce = headerValue(headers, EXECUTION_SIGNATURE_HEADERS.nonce);
  const signatureText = headerValue(headers, EXECUTION_SIGNATURE_HEADERS.signature);
  const timestamp = headerValue(headers, EXECUTION_SIGNATURE_HEADERS.timestamp);

  if (algorithm !== SIGNATURE_ALGORITHM) throw createAuthError('Execution request signature algorithm is invalid.');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) throw createAuthError('Execution request key id is invalid.');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw createAuthError('Execution request nonce is invalid.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText) || signatureText.length > 2048) {
    throw createAuthError('Execution request signature is invalid.');
  }

  const signedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(signedAtMs)) throw createAuthError('Execution request timestamp is invalid.');
  if (signedAtMs > nowMs + Math.max(0, Number(maxFutureMs) || 0)) {
    throw createAuthError('Execution request timestamp is in the future.');
  }
  if (nowMs - signedAtMs > Math.max(1000, Number(maxAgeMs) || DEFAULT_SIGNATURE_MAX_AGE_MS)) {
    throw createAuthError('Execution request signature has expired.');
  }

  const keys = normalizeKeyMap(publicKeys);
  const publicKeyPem = keys.get(keyId);
  if (!publicKeyPem) throw createAuthError('Execution request key id is not trusted.');

  const message = buildSigningMessage({
    bodyText,
    method,
    nonce,
    targetPath,
    timestamp
  });
  let signature;
  try {
    signature = Buffer.from(signatureText, 'base64');
  } catch (_error) {
    throw createAuthError('Execution request signature is invalid.');
  }
  if (
    !signature.length
    || !verifyWithKey('RSA-SHA256', Buffer.from(message, 'utf8'), publicKeyPem, signature)
  ) {
    throw createAuthError('Execution request signature does not match the request.');
  }

  const maxEntries = Math.max(
    1000,
    Math.floor(Number(process.env.EXECUTION_REPLAY_CACHE_MAX) || DEFAULT_REPLAY_CACHE_MAX)
  );
  pruneReplayNonces(replayStore, nowMs, maxEntries);
  const replayKey = `${keyId}:${nonce}`;
  if (replayStore.has(replayKey)) throw createAuthError('Execution request signature was already used.');
  replayStore.set(replayKey, signedAtMs + Math.max(1000, Number(maxAgeMs) || DEFAULT_SIGNATURE_MAX_AGE_MS));

  return { keyId, nonce, signedAt: new Date(signedAtMs).toISOString() };
}

export async function assertExecutionRequestAuthorized(req, options = {}) {
  const production = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const authRequired = options.authRequired === undefined
    ? parseBoolean(
        process.env.EXECUTION_RECEIVER_AUTH_REQUIRED || process.env.EXECUTION_AUTH_REQUIRED,
        production
      )
    : Boolean(options.authRequired);
  if (!authRequired) return { authorized: true, mode: 'disabled' };

  const apiKey = String(
    options.apiKey
    || process.env.EXECUTION_API_KEY
    || process.env.EXECUTION_SERVER_API_KEY
    || process.env.PROOF_EXECUTION_API_KEY
    || process.env.ORACLE_SERVER_API_KEY
    || ''
  ).trim();
  const requireSignature = options.requireSignature === undefined
    ? parseBoolean(process.env.EXECUTION_SIGNATURE_REQUIRED, production)
    : Boolean(options.requireSignature);
  const requireBearer = options.requireBearer === undefined
    ? parseBoolean(process.env.EXECUTION_BEARER_REQUIRED, Boolean(apiKey))
    : Boolean(options.requireBearer);

  if (!requireSignature && !requireBearer) {
    throw createAuthError('Execution receiver authentication has no required mechanism.', 503);
  }

  if (requireBearer) {
    if (!apiKey) throw createAuthError('Execution bearer authentication is required but no API key is configured.', 503);
    const authorization = headerValue(req && req.headers, 'authorization');
    const match = authorization.match(/^Bearer[ \t]+(.+)$/i);
    if (!match || !secureStringEqual(match[1].trim(), apiKey)) {
      throw createAuthError('Execution bearer authentication failed.');
    }
  }

  let signature = null;
  if (requireSignature) {
    const publicKeys = options.publicKeys || await getExecutionPublicKeys();
    if (!normalizeKeyMap(publicKeys).size) {
      throw createAuthError('Execution signature verification is required but no public key is configured.', 503);
    }
    const rawBody = req && Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : (typeof req?.rawBody === 'string' ? req.rawBody : JSON.stringify(req?.body || {}));
    signature = verifyExecutionRequestSignature({
      bodyText: rawBody,
      headers: req && req.headers,
      method: req && req.method,
      publicKeys,
      replayStore: options.replayStore,
      targetPath: req && (req.originalUrl || req.url),
      nowMs: options.nowMs === undefined ? Date.now() : options.nowMs
    });
  }

  return {
    authorized: true,
    mode: requireSignature && requireBearer ? 'signature+bearer' : requireSignature ? 'signature' : 'bearer',
    signature
  };
}

export function isLikelyOracleControlPlaneUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim();
  if (!normalized) {
    return false;
  }
  return /^https:\/\/iaas\.[^.]+-\d+\.oraclecloud\.com\/?$/i.test(normalized);
}
