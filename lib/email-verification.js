import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import nodemailer from 'nodemailer';

import { assertDistributedRateLimit, getTrustedClientAddress } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { getSupabaseAdmin } from './supabase-admin.js';

const CHALLENGE_COOKIE = 'ivucx_email_challenge';
const IDENTITY_COOKIE = 'ivucx_email_identity';
const CHALLENGE_MAX_AGE_SECONDS = 10 * 60;
const IDENTITY_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_VERIFY_ATTEMPTS = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;

const sendRateBucket = new Map();

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizeEmail(value) {
  const email = safeString(value).toLowerCase();
  if (!email || email.length > 254) return '';
  const [local, domain, ...extra] = email.split('@');
  if (extra.length || !local || local.length > 64 || !domain || domain.length > 253) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function encodeBase64Url(value) {
  return Buffer.from(String(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getCookieSecret() {
  return safeString(
    process.env.EMAIL_VERIFICATION_SECRET
    || process.env.GOOGLE_IDENTITY_COOKIE_SECRET
    || process.env.IVUCX_LEDGER_SECRET
    || process.env.VX_LEDGER_SECRET
  );
}

function hmacBase64Url(value, secret = getCookieSecret()) {
  if (!secret) {
    const error = new Error('Email verification cookie signing secret is missing.');
    error.statusCode = 500;
    throw error;
  }
  return createHmac('sha256', secret)
    .update(String(value || ''))
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function secureCookieEnabled() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
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

function parseCookies(req) {
  const cookies = {};
  String(req && req.headers && req.headers.cookie || '')
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!key) return;
      cookies[key] = decodeURIComponent(value);
    });
  return cookies;
}

function signPayload(payload) {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${encoded}.${hmacBase64Url(encoded)}`;
}

function readSignedPayload(req, cookieName) {
  const raw = parseCookies(req)[cookieName];
  if (!raw || !raw.includes('.')) return null;
  const [payload, signature] = String(raw).split('.');
  if (!payload || !signature) return null;
  const expected = hmacBase64Url(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    return JSON.parse(decodeBase64Url(payload));
  } catch (error) {
    return null;
  }
}

function buildCookie(name, value, maxAge) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(Number(maxAge) || 0))}`,
    'Path=/',
    'SameSite=Lax',
    'HttpOnly'
  ];
  if (secureCookieEnabled()) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie(name) {
  const attrs = [
    `${name}=`,
    'Max-Age=0',
    'Path=/',
    'SameSite=Lax',
    'HttpOnly'
  ];
  if (secureCookieEnabled()) attrs.push('Secure');
  return attrs.join('; ');
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '';
  const visible = local.length <= 2 ? local[0] : `${local.slice(0, 2)}...${local.slice(-1)}`;
  return `${visible}@${domain}`;
}

function resolveDeliveryEmail(email, smtpUser) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUser = normalizeEmail(smtpUser);
  if (!normalizedEmail || normalizedEmail !== normalizedUser) {
    return {
      deliveryEmail: normalizedEmail,
      sameMailboxAlias: false
    };
  }
  const [local, domain] = normalizedEmail.split('@');
  if (!local || !domain || domain !== 'gmail.com') {
    return {
      deliveryEmail: normalizedEmail,
      sameMailboxAlias: true
    };
  }
  const baseLocal = local.split('+')[0];
  return {
    deliveryEmail: `${baseLocal}+provf-login@${domain}`,
    sameMailboxAlias: true
  };
}

function consumeSendRateLimit(req, email) {
  const now = Date.now();
  const key = `${getTrustedClientAddress(req)}:${email}`;
  const existing = sendRateBucket.get(key) || [];
  const recent = existing.filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    const error = new Error('Too many verification codes were requested. Please wait a few minutes.');
    error.statusCode = 429;
    throw error;
  }
  recent.push(now);
  sendRateBucket.set(key, recent);
  if (sendRateBucket.size > 1000) {
    for (const [bucketKey, values] of sendRateBucket.entries()) {
      const nextValues = values.filter((time) => now - time < RATE_WINDOW_MS);
      if (nextValues.length) sendRateBucket.set(bucketKey, nextValues);
      else sendRateBucket.delete(bucketKey);
    }
  }
}

function createVerificationCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0');
}

function hashVerificationCode(email, nonce, code) {
  return hmacBase64Url(`${email}:${nonce}:${String(code || '').replace(/\D/g, '')}`);
}

function hashEmail(email) {
  return createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');
}

function getChallengeStore() {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    const unavailable = new Error(error || 'Email verification storage is unavailable.');
    unavailable.statusCode = 503;
    throw unavailable;
  }
  return client;
}

function createChallengeStoreError(error) {
  const detail = safeString(error && (error.message || error.details || error.hint));
  const unavailable = new Error(
    detail && /email_verification_challenges|consume_email_verification_attempt/i.test(detail)
      ? 'Email verification security storage is not ready. Apply the latest Supabase migration.'
      : (detail || 'Email verification security storage is unavailable.')
  );
  unavailable.statusCode = 503;
  return unavailable;
}

async function persistChallenge({ nonce, email, codeHash, expiresAt }) {
  const client = getChallengeStore();
  const { error } = await client
    .from('email_verification_challenges')
    .insert({
      nonce,
      email_hash: hashEmail(email),
      code_hash: codeHash,
      attempts: 0,
      max_attempts: MAX_VERIFY_ATTEMPTS,
      expires_at: new Date(expiresAt).toISOString()
    });
  if (error) throw createChallengeStoreError(error);
}

async function deleteChallenge(nonce) {
  try {
    const client = getChallengeStore();
    await client.from('email_verification_challenges').delete().eq('nonce', nonce);
  } catch (error) {
    // Expired challenges are also removed by the database cleanup path.
  }
}

async function consumeChallengeAttempt(nonce, email) {
  const client = getChallengeStore();
  const { data, error } = await client.rpc('consume_email_verification_attempt', {
    p_nonce: nonce,
    p_email_hash: hashEmail(email)
  });
  if (error) throw createChallengeStoreError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? row : { status: 'missing', code_hash: '' };
}

async function markChallengeConsumed(nonce) {
  const client = getChallengeStore();
  const { data, error } = await client
    .from('email_verification_challenges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('nonce', nonce)
    .is('consumed_at', null)
    .select('nonce')
    .maybeSingle();
  if (error) throw createChallengeStoreError(error);
  if (!data || !data.nonce) {
    const conflict = new Error('Verification code was already used.');
    conflict.statusCode = 409;
    throw conflict;
  }
}

function getSmtpConfig() {
  const host = safeString(process.env.SMTP_HOST || process.env.EMAIL_SMTP_HOST, 'smtp.gmail.com');
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || process.env.EMAIL_SMTP_SECURE || 'true').toLowerCase() !== 'false';
  const user = safeString(process.env.SMTP_USER || process.env.EMAIL_FROM_ADDRESS || process.env.GMAIL_SMTP_USER);
  const rawPass = safeString(process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD);
  const pass = rawPass.replace(/\s+/g, '');
  const fromName = safeString(process.env.EMAIL_FROM_NAME, 'PROVF');
  if (!user || !pass) {
    const error = new Error('SMTP_USER and SMTP_PASS are required for email verification.');
    error.statusCode = 500;
    throw error;
  }
  return { host, port, secure, user, pass, fromName };
}

async function sendVerificationEmail(email, code) {
  const config = getSmtpConfig();
  const delivery = resolveDeliveryEmail(email, config.user);
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  const info = await transporter.sendMail({
    from: `"${config.fromName}" <${config.user}>`,
    sender: config.user,
    replyTo: config.user,
    to: delivery.deliveryEmail,
    subject: 'PROVF verification code',
    text: [
      `Your PROVF verification code is ${code}.`,
      '',
      'This code expires in 10 minutes.',
      'If you did not request it, you can ignore this email.'
    ].join('\n'),
    html: [
      '<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111827">',
      '<p>Your PROVF verification code is:</p>',
      `<div style="font-size:28px;font-weight:700;letter-spacing:0.18em">${code}</div>`,
      '<p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>',
      '</div>'
    ].join('')
  });
  const accepted = Array.isArray(info.accepted) ? info.accepted : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected : [];
  console.info('[email-verification] sent', {
    to: maskEmail(email),
    deliveryTo: maskEmail(delivery.deliveryEmail),
    sameMailboxAlias: delivery.sameMailboxAlias,
    accepted: accepted.length,
    rejected: rejected.length,
    messageId: safeString(info.messageId)
  });
  if (accepted.length === 0 || rejected.length > 0) {
    const error = new Error('SMTP accepted no recipients for the verification email.');
    error.statusCode = 502;
    throw error;
  }
  return {
    sameMailboxAlias: delivery.sameMailboxAlias,
    deliveryEmail: delivery.deliveryEmail
  };
}

function setChallengeCookie(res, payload) {
  appendSetCookie(res, buildCookie(CHALLENGE_COOKIE, signPayload(payload), CHALLENGE_MAX_AGE_SECONDS));
}

function clearChallengeCookie(res) {
  appendSetCookie(res, clearCookie(CHALLENGE_COOKIE));
}

function setIdentityCookie(res, email) {
  const expiresAt = Date.now() + IDENTITY_MAX_AGE_SECONDS * 1000;
  const localPart = String(email).split('@')[0] || email;
  const payload = {
    sub: `email:${email}`,
    email,
    name: localPart,
    provider: 'email',
    expires_at: expiresAt
  };
  appendSetCookie(res, buildCookie(IDENTITY_COOKIE, signPayload(payload), IDENTITY_MAX_AGE_SECONDS));
}

export function clearEmailIdentityCookie(res) {
  appendSetCookie(res, clearCookie(IDENTITY_COOKIE));
  appendSetCookie(res, clearCookie(CHALLENGE_COOKIE));
}

export function getEmailIdentity(req) {
  const payload = readSignedPayload(req, IDENTITY_COOKIE);
  if (!payload || payload.provider !== 'email') {
    return {
      authenticated: false,
      accountId: '',
      email: '',
      name: ''
    };
  }
  if (Number(payload.expires_at) && Date.now() > Number(payload.expires_at) - 30000) {
    return {
      authenticated: false,
      accountId: '',
      email: '',
      name: ''
    };
  }
  const email = normalizeEmail(payload.email);
  if (!email) {
    return {
      authenticated: false,
      accountId: '',
      email: '',
      name: ''
    };
  }
  return {
    authenticated: true,
    accountProvider: 'email',
    accountId: email,
    email,
    name: safeString(payload.name, email.split('@')[0])
  };
}

async function handleSend(req, res, body) {
  const email = normalizeEmail(body.email);
  if (!email) {
    res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    return;
  }
  await assertDistributedRateLimit(req, {
    route: 'email-verification-send',
    discriminator: hashEmail(email),
    limit: RATE_LIMIT,
    windowSeconds: Math.floor(RATE_WINDOW_MS / 1000)
  });
  await assertDistributedRateLimit(req, {
    route: 'email-verification-send-account',
    discriminator: hashEmail(email),
    includeClientAddress: false,
    limit: RATE_LIMIT,
    windowSeconds: Math.floor(RATE_WINDOW_MS / 1000)
  });
  consumeSendRateLimit(req, email);

  const code = createVerificationCode();
  const nonce = randomUUID();
  const expiresAt = Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000;
  await persistChallenge({
    nonce,
    email,
    codeHash: hashVerificationCode(email, nonce, code),
    expiresAt
  });
  let delivery;
  try {
    delivery = await sendVerificationEmail(email, code);
  } catch (error) {
    await deleteChallenge(nonce);
    throw error;
  }
  setChallengeCookie(res, {
    nonce,
    emailHash: hashEmail(email),
    expires_at: expiresAt
  });
  res.status(200).json({
    ok: true,
    sent: true,
    email: maskEmail(email),
    hint: delivery.sameMailboxAlias
      ? 'The sender mailbox is the same Gmail account, so the code was delivered through a Gmail plus alias. Check Inbox, All Mail, or Sent if it is not visible.'
      : '',
    expiresInSeconds: CHALLENGE_MAX_AGE_SECONDS
  });
}

async function handleConfirm(req, res, body) {
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').replace(/\D/g, '');
  if (!email || code.length !== 6) {
    res.status(400).json({ ok: false, error: 'A valid email address and 6-digit code are required.' });
    return;
  }
  await assertDistributedRateLimit(req, {
    route: 'email-verification-confirm',
    discriminator: hashEmail(email),
    limit: 30,
    windowSeconds: Math.floor(RATE_WINDOW_MS / 1000)
  });
  await assertDistributedRateLimit(req, {
    route: 'email-verification-confirm-account',
    discriminator: hashEmail(email),
    includeClientAddress: false,
    limit: 30,
    windowSeconds: Math.floor(RATE_WINDOW_MS / 1000)
  });

  const challenge = readSignedPayload(req, CHALLENGE_COOKIE);
  if (!challenge || safeString(challenge.emailHash) !== hashEmail(email)) {
    res.status(400).json({ ok: false, error: 'Verification code was not requested for this email.' });
    return;
  }
  if (Number(challenge.expires_at) && Date.now() > Number(challenge.expires_at)) {
    clearChallengeCookie(res);
    res.status(410).json({ ok: false, error: 'Verification code expired. Please request a new code.' });
    return;
  }
  const attempt = await consumeChallengeAttempt(challenge.nonce, email);
  const attemptStatus = safeString(attempt.status).toLowerCase();
  if (attemptStatus !== 'ok') {
    if (['expired', 'consumed', 'max_attempts'].includes(attemptStatus)) clearChallengeCookie(res);
    const status = attemptStatus === 'max_attempts' ? 429 : (attemptStatus === 'expired' ? 410 : 400);
    const message = attemptStatus === 'max_attempts'
      ? 'Too many verification attempts. Please request a new code.'
      : (attemptStatus === 'expired'
        ? 'Verification code expired. Please request a new code.'
        : 'Verification code is no longer valid. Please request a new code.');
    res.status(status).json({ ok: false, error: message });
    return;
  }

  const expected = String(attempt.code_hash || '');
  const actual = hashVerificationCode(email, challenge.nonce, code);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    res.status(401).json({ ok: false, error: 'Verification code is incorrect.' });
    return;
  }

  await markChallengeConsumed(challenge.nonce);
  clearChallengeCookie(res);
  setIdentityCookie(res, email);
  res.status(200).json({
    ok: true,
    verified: true,
    accountId: email,
    email,
    provider: 'email'
  });
}

export async function sendEmailVerificationResponse(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = safeString(body.action || body.intent || body.mode, 'send').toLowerCase();
    if (action === 'send' || action === 'start') {
      await handleSend(req, res, body);
      return;
    }
    if (action === 'confirm' || action === 'verify') {
      await handleConfirm(req, res, body);
      return;
    }
    res.status(400).json({ ok: false, error: 'Unknown email verification action.' });
  } catch (error) {
    const status = getHttpErrorStatus(error);
    if (error && error.retryAfter) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    res.status(status).json({
      ok: false,
      error: getPublicErrorMessage(error, 'Email verification is temporarily unavailable.', status)
    });
  }
}
