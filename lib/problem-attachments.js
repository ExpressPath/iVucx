import crypto from 'crypto';

import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getIvucxIdentity } from './ivucx.js';
import { identityOwnsProblem, verifyProblemCapability } from './problem-access.js';
import { getSupabaseAdmin, resolveSupabaseAdminEnv } from './supabase-admin.js';

const ATTACHMENT_BUCKET = 'problem-attachments';
const MAX_ATTACHMENT_COUNT = Math.max(1, Number(process.env.PROBLEM_ATTACHMENT_MAX_COUNT || 100));
const MAX_ATTACHMENT_FILE_BYTES = Math.max(1024, Number(process.env.PROBLEM_ATTACHMENT_FILE_MAX_BYTES || 50 * 1024 * 1024));
const MAX_ATTACHMENT_BYTES = Math.max(MAX_ATTACHMENT_FILE_BYTES, Number(process.env.PROBLEM_ATTACHMENT_TOTAL_MAX_BYTES || 250 * 1024 * 1024));
const ATTACHMENT_SIGN_LIMIT_PER_PROBLEM = Math.max(1, Number(process.env.PROBLEM_ATTACHMENT_SIGN_LIMIT_PER_HOUR || 10));
const ATTACHMENT_COMPLETE_LIMIT_PER_PROBLEM = Math.max(1, Number(process.env.PROBLEM_ATTACHMENT_COMPLETE_LIMIT_PER_HOUR || 20));

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function parseBody(body) {
  if (isPlainObject(body)) return body;
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body);
      return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  return {};
}

function createRequestError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function sanitizePathPart(value, fallback = 'file') {
  const normalized = safeString(value, fallback)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .replace(/[^\w.!$&'()+,;=@[\]-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function getExtension(name) {
  const match = safeString(name).toLowerCase().match(/\.([a-z0-9][a-z0-9+_-]{0,16})$/);
  return match ? match[1] : '';
}

function normalizeMime(value) {
  return safeString(value).split(';')[0].trim().toLowerCase();
}

function kindFromMime(value) {
  const mime = normalizeMime(value);
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return '';
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function normalizeAttachment(input, index) {
  if (!isPlainObject(input)) return null;
  const id = sanitizePathPart(input.id || input.blobId || `attachment-${index + 1}`, `attachment-${index + 1}`);
  const rawName = safeString(input.title || input.name || input.fileName, `attachment-${index + 1}`);
  const relativePath = sanitizePathPart(input.relativePath || input.path || rawName, rawName);
  const fileName = sanitizePathPart(rawName.split(/[\\/]/).pop(), `attachment-${index + 1}`);
  const size = Math.max(0, Number(input.size) || 0);
  const ext = safeString(input.ext || getExtension(fileName));
  const mime = safeString(input.mime || input.type);
  return {
    id,
    clientId: safeString(input.clientId || input.id || input.blobId, id),
    title: rawName,
    fileName,
    relativePath,
    kind: safeString(input.kind, 'file'),
    ext,
    mime,
    size,
    scanStatus: safeString(input.scanStatus),
    scanLabel: safeString(input.scanLabel),
    scanCheckedAt: safeString(input.scanCheckedAt),
    importedAt: safeString(input.importedAt),
    source: safeString(input.source, 'local')
  };
}

function normalizeAttachmentList(input) {
  const items = Array.isArray(input) ? input : [];
  return items
    .map((item, index) => normalizeAttachment(item, index))
    .filter(Boolean);
}

function assertAttachmentQuota(attachments) {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw createRequestError(413, `Too many attachments. Maximum is ${MAX_ATTACHMENT_COUNT}.`);
  }
  const oversized = attachments.find((item) => Number(item.size) > MAX_ATTACHMENT_FILE_BYTES);
  if (oversized) {
    throw createRequestError(413, `Attachment exceeds the ${Math.round(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)} MB per-file limit.`);
  }
  const totalBytes = attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw createRequestError(413, `Attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB per-problem storage limit.`);
  }
}

async function ensureProblemExists(client, problemId) {
  const { data, error } = await client
    .from('problems')
    .select('id, request_meta')
    .eq('id', problemId)
    .maybeSingle();

  if (error) {
    throw createRequestError(500, error.message || 'Failed to load problem row.', error);
  }
  if (!data || !data.id) {
    throw createRequestError(404, 'Problem row was not found for attachment persistence.');
  }
  return data;
}

async function ensureAttachmentBucket(client) {
  const existing = await client.storage.getBucket(ATTACHMENT_BUCKET);
  if (!existing.error) return;

  const status = Number(existing.error.status || existing.error.statusCode || 0);
  const message = String(existing.error.message || '');
  if (status && status !== 404 && !message.toLowerCase().includes('not found')) {
    throw createRequestError(500, message || 'Failed to inspect attachment bucket.', existing.error);
  }

  const created = await client.storage.createBucket(ATTACHMENT_BUCKET, {
    public: false
  });
  if (created.error) {
    const createMessage = String(created.error.message || '');
    if (!createMessage.toLowerCase().includes('already exists')) {
      throw createRequestError(500, createMessage || 'Failed to create attachment bucket.', created.error);
    }
  }
}

function buildStoragePath(problemId, attachment, index) {
  const relativePath = sanitizePathPart(attachment.relativePath || attachment.fileName, attachment.fileName);
  const digest = sha256Text(`${attachment.clientId}:${relativePath}:${index}`).slice(0, 12);
  const nonce = crypto.randomBytes(8).toString('hex');
  return `problems/${problemId}/${nonce}-${digest}/${relativePath}`;
}

function getStoragePrefix(problemId) {
  return `problems/${safeString(problemId)}/`;
}

async function assertAttachmentAccess(req, client, problem, input) {
  const identity = await getIvucxIdentity(req, client);
  const meta = isPlainObject(problem && problem.request_meta) ? problem.request_meta : {};
  if (identityOwnsProblem(identity, meta)) return;
  const token = safeString(input && (input.attachmentToken || input.capabilityToken));
  if (token && verifyProblemCapability(problem.id, token, 'attachments')) return;
  throw createRequestError(identity && identity.authenticated ? 403 : 401, 'Attachment access is not authorized for this problem.');
}

function publicUploadHeaders() {
  const { anonKey } = resolveSupabaseAdminEnv();
  if (!anonKey) return {};
  return {
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`
  };
}

export async function createProblemAttachmentUploadPlan(body, req = null) {
  const input = parseBody(body);
  const problemId = safeString(input.problemId);
  if (!problemId) {
    throw createRequestError(400, 'problemId is required.');
  }

  const attachments = normalizeAttachmentList(input.attachments);
  assertAttachmentQuota(attachments);

  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw createRequestError(503, error || 'Supabase is not configured on this server.');
  }

  const problem = await ensureProblemExists(client, problemId);
  await assertAttachmentAccess(req, client, problem, input);
  await assertDistributedRateLimit(req, {
    route: 'attachment-sign-problem',
    discriminator: problemId,
    includeClientAddress: false,
    limit: ATTACHMENT_SIGN_LIMIT_PER_PROBLEM,
    windowSeconds: 60 * 60
  });
  await ensureAttachmentBucket(client);

  const uploadHeaders = publicUploadHeaders();
  const uploads = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const storagePath = buildStoragePath(problemId, attachment, index);
    const signed = await client.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (signed.error || !signed.data) {
      throw createRequestError(
        500,
        signed.error && signed.error.message ? signed.error.message : 'Failed to create attachment upload URL.',
        signed.error || null
      );
    }
    uploads.push({
      ...attachment,
      bucket: ATTACHMENT_BUCKET,
      storagePath,
      signedUrl: signed.data.signedUrl,
      token: signed.data.token,
      uploadHeaders
    });
  }

  return {
    bucket: ATTACHMENT_BUCKET,
    uploads,
    totalBytes: attachments.reduce((sum, item) => sum + item.size, 0)
  };
}

async function verifyUploadedAttachment(client, problemId, attachment) {
  const storagePath = safeString(attachment.storagePath);
  if (!storagePath) {
    throw createRequestError(400, 'Attachment storagePath is required.');
  }
  if (!storagePath.startsWith(getStoragePrefix(problemId))) {
    throw createRequestError(403, 'Attachment storagePath does not belong to this problem.');
  }
  const info = await client.storage.from(ATTACHMENT_BUCKET).info(storagePath);
  if (info.error) {
    throw createRequestError(
      400,
      `Attachment was not found in Supabase Storage: ${storagePath}`,
      info.error
    );
  }
  const data = info.data || {};
  const actualSize = Math.max(0, Number(data.size || (data.metadata && data.metadata.size)) || 0);
  const actualMime = normalizeMime(
    data.contentType
      || data.mimetype
      || (data.metadata && (data.metadata.contentType || data.metadata.mimetype))
  );
  if (actualSize > MAX_ATTACHMENT_FILE_BYTES) {
    throw createRequestError(413, 'Uploaded attachment exceeds the per-file size limit.');
  }
  return { ...data, verifiedSize: actualSize, verifiedMime: actualMime };
}

function buildSavedAttachment(input, info) {
  const normalized = normalizeAttachment(input, 0) || {};
  const verifiedMime = normalizeMime(info && info.verifiedMime);
  const verifiedKind = kindFromMime(verifiedMime);
  return {
    id: normalized.clientId || normalized.id || safeString(input.id),
    title: normalized.title || safeString(input.title, 'Uploaded file'),
    fileName: normalized.fileName || safeString(input.fileName, 'Uploaded file'),
    relativePath: normalized.relativePath || safeString(input.relativePath || input.path),
    kind: verifiedKind || normalized.kind || safeString(input.kind, 'file'),
    ext: normalized.ext || safeString(input.ext),
    mime: verifiedMime || normalizeMime(normalized.mime || input.mime),
    size: Number(info.verifiedSize) || Number(info.size) || normalized.size || Number(input.size) || 0,
    bucket: ATTACHMENT_BUCKET,
    storagePath: safeString(input.storagePath),
    storageObjectId: safeString(info.id),
    savedAt: new Date().toISOString(),
    scanStatus: 'pending',
    scanLabel: '',
    scanCheckedAt: '',
    source: normalized.source || safeString(input.source, 'local')
  };
}

export async function completeProblemAttachmentPersistence(body, req = null) {
  const input = parseBody(body);
  const problemId = safeString(input.problemId);
  if (!problemId) {
    throw createRequestError(400, 'problemId is required.');
  }

  const uploaded = normalizeAttachmentList(input.attachments);
  assertAttachmentQuota(uploaded);

  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw createRequestError(503, error || 'Supabase is not configured on this server.');
  }

  const problem = await ensureProblemExists(client, problemId);
  await assertAttachmentAccess(req, client, problem, input);
  await assertDistributedRateLimit(req, {
    route: 'attachment-complete-problem',
    discriminator: problemId,
    includeClientAddress: false,
    limit: ATTACHMENT_COMPLETE_LIMIT_PER_PROBLEM,
    windowSeconds: 60 * 60
  });
  const savedAttachments = [];
  for (const attachment of Array.isArray(input.attachments) ? input.attachments : []) {
    if (!isPlainObject(attachment)) continue;
    const info = await verifyUploadedAttachment(client, problemId, attachment);
    savedAttachments.push(buildSavedAttachment(attachment, info));
  }
  assertAttachmentQuota(savedAttachments);

  const previousMeta = isPlainObject(problem.request_meta) ? problem.request_meta : {};
  const nextMeta = {
    ...previousMeta,
    attachments: savedAttachments,
    attachmentStorage: {
      bucket: ATTACHMENT_BUCKET,
      count: savedAttachments.length,
      totalBytes: savedAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0),
      savedAt: new Date().toISOString()
    }
  };

  const updated = await client
    .from('problems')
    .update({ request_meta: nextMeta })
    .eq('id', problemId)
    .select('id')
    .single();

  if (updated.error) {
    throw createRequestError(500, updated.error.message || 'Failed to attach upload metadata to problem.', updated.error);
  }

  return {
    problemId,
    bucket: ATTACHMENT_BUCKET,
    attachments: savedAttachments
  };
}

export async function sendAttachmentUploadPlanResponse(req, res) {
  try {
    await assertDistributedRateLimit(req, { route: 'attachment-sign', limit: 30, windowSeconds: 60 });
    const plan = await createProblemAttachmentUploadPlan(req.body, req);
    res.status(200).json({ ok: true, ...plan });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    const status = error.statusCode || error.status || 500;
    res.status(status).json({
      ok: false,
      error: process.env.NODE_ENV === 'production' && status >= 500
        ? 'Attachment upload plan failed.'
        : (error.message || 'Attachment upload plan failed.'),
      details: process.env.NODE_ENV === 'production' ? undefined : (error.details || null)
    });
  }
}

export async function sendAttachmentCompleteResponse(req, res) {
  try {
    await assertDistributedRateLimit(req, { route: 'attachment-complete', limit: 30, windowSeconds: 60 });
    const result = await completeProblemAttachmentPersistence(req.body, req);
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    const status = error.statusCode || error.status || 500;
    res.status(status).json({
      ok: false,
      error: process.env.NODE_ENV === 'production' && status >= 500
        ? 'Attachment persistence failed.'
        : (error.message || 'Attachment persistence failed.'),
      details: process.env.NODE_ENV === 'production' ? undefined : (error.details || null)
    });
  }
}
