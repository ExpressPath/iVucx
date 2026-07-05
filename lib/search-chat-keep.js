import { createHash, randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';
import { getGoogleIdentity } from './google-oauth.js';
import { hashSessionToken, readSessionFromRequest } from './blue-auth.js';

const MAX_TURNS = 20;
const MAX_CITATIONS_PER_TURN = 24;
const MAX_QUERY_CHARS = 1200;
const MAX_ANSWER_CHARS = 24000;
const MAX_TEXT_CHARS = 3600;
const SEARCH_KEEP_BUCKET = 'search-chat-keeps';

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function truncateText(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function hashIdentifier(value) {
  const text = safeString(value);
  return text ? createHash('sha256').update(text).digest('hex') : '';
}

function isNotFoundStorageError(error) {
  const status = Number(error && (error.statusCode || error.status));
  const message = String(error && (error.message || error.error || '')).toLowerCase();
  return status === 404 || message.includes('not found') || message.includes('does not exist');
}

function isMissingTableError(error) {
  return error && error.code === '42P01';
}

function isMissingColumnError(error) {
  return error && error.code === '42703';
}

function readBody(req) {
  if (!req || typeof req !== 'object') return {};
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      return {};
    }
  }
  return typeof req.body === 'object' ? req.body : {};
}

async function getBlueSessionIdentity(req, supabase) {
  if (!supabase) return null;
  const rawSession = readSessionFromRequest(req);
  if (!rawSession) return null;
  const tokenHash = hashSessionToken(rawSession);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('blue_sessions')
    .select('account_id, expires_at, revoked_at')
    .eq('session_token_hash', tokenHash)
    .is('revoked_at', null)
    .gt('expires_at', now)
    .maybeSingle();
  if (error || !data || !data.account_id) return null;
  return {
    authenticated: true,
    accountProvider: 'blue',
    accountId: safeString(data.account_id),
    email: '',
    name: ''
  };
}

async function getAccountIdentity(req, supabase) {
  const google = await getGoogleIdentity(req);
  if (google && google.authenticated) {
    return {
      authenticated: true,
      accountProvider: 'google',
      accountId: safeString(google.accountId || google.email || google.name, 'Google account'),
      email: safeString(google.email),
      name: safeString(google.name)
    };
  }

  const blue = await getBlueSessionIdentity(req, supabase);
  if (blue && blue.authenticated) return blue;
  return {
    authenticated: false,
    accountProvider: '',
    accountId: '',
    email: '',
    name: ''
  };
}

function normalizeCitation(rawCitation) {
  const citation = rawCitation && typeof rawCitation === 'object' ? rawCitation : {};
  return {
    id: truncateText(citation.id, 80),
    problemId: truncateText(citation.problemId, 80),
    title: truncateText(citation.title, 300),
    kind: truncateText(citation.kind, 40),
    fileName: truncateText(citation.fileName, 240),
    language: truncateText(citation.language, 80),
    proofState: truncateText(citation.proofState, 20),
    normalizedFormat: truncateText(citation.normalizedFormat, 80),
    quote: truncateText(citation.quote, MAX_TEXT_CHARS)
  };
}

function normalizeTurn(rawTurn, index) {
  const turn = rawTurn && typeof rawTurn === 'object' ? rawTurn : {};
  const citations = Array.isArray(turn.citations)
    ? turn.citations.slice(0, MAX_CITATIONS_PER_TURN).map(normalizeCitation)
    : [];
  return {
    id: Number.isFinite(Number(turn.id)) ? Number(turn.id) : index + 1,
    query: truncateText(turn.query, MAX_QUERY_CHARS),
    answer: truncateText(turn.answer || turn.fullAnswer, MAX_ANSWER_CHARS),
    targetKind: truncateText(turn.targetKind || 'search', 40),
    systemMode: truncateText(turn.systemMode || '', 24),
    citationCount: citations.length,
    citations
  };
}

function normalizeConversation(body) {
  const sourceTurns = Array.isArray(body.turns) ? body.turns : [];
  const turns = sourceTurns
    .slice(0, MAX_TURNS)
    .map(normalizeTurn)
    .filter((turn) => turn.query || turn.answer);
  const firstQuery = turns.find((turn) => turn.query);
  const title = truncateText(body.title || (firstQuery && firstQuery.query) || 'Search chat', 180);
  const citationCount = turns.reduce((sum, turn) => sum + turn.citationCount, 0);
  return {
    title,
    systemMode: truncateText(body.systemMode || '', 24),
    turnCount: turns.length,
    citationCount,
    conversation: {
      source: 'provf-search',
      keptAt: new Date().toISOString(),
      systemMode: truncateText(body.systemMode || '', 24),
      turns
    }
  };
}

async function ensureSearchKeepBucket(supabase) {
  const existing = await supabase.storage.getBucket(SEARCH_KEEP_BUCKET);
  if (!existing.error) return;
  if (!isNotFoundStorageError(existing.error)) {
    throw existing.error;
  }

  const created = await supabase.storage.createBucket(SEARCH_KEEP_BUCKET, {
    public: false,
    fileSizeLimit: '1MB',
    allowedMimeTypes: ['application/json']
  });
  if (
    created.error
    && !String(created.error.message || '').toLowerCase().includes('already exists')
  ) {
    throw created.error;
  }
}

async function persistSearchKeepToStorage({ supabase, row, normalized }) {
  await ensureSearchKeepBucket(supabase);
  const now = new Date().toISOString();
  const dateKey = now.slice(0, 10);
  const path = [
    row.account_provider || 'account',
    row.account_id_hash || 'unknown',
    `${dateKey}-${randomUUID()}.json`
  ].join('/');
  const payload = {
    id: path,
    storageBucket: SEARCH_KEEP_BUCKET,
    title: normalized.title,
    accountProvider: row.account_provider,
    accountIdHash: row.account_id_hash,
    email: row.email,
    name: row.name,
    systemMode: normalized.systemMode,
    turnCount: normalized.turnCount,
    citationCount: normalized.citationCount,
    createdAt: now,
    updatedAt: now,
    conversation: normalized.conversation
  };
  const uploaded = await supabase.storage
    .from(SEARCH_KEEP_BUCKET)
    .upload(path, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
      contentType: 'application/json',
      upsert: false
    });
  if (uploaded.error) throw uploaded.error;
  return {
    path,
    bucket: SEARCH_KEEP_BUCKET,
    createdAt: now
  };
}

export async function sendSearchChatKeepResponse(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = readBody(req);
    const { client: supabase, error: supabaseError } = getSupabaseAdmin();
    const identity = await getAccountIdentity(req, supabase);

    if (!identity.authenticated) {
      res.status(401).json({
        ok: false,
        saved: false,
        reason: 'not_logged_in',
        error: 'Sign in before keeping this chat.'
      });
      return;
    }

    if (!supabase) {
      res.status(503).json({
        ok: false,
        saved: false,
        reason: 'supabase_unavailable',
        detail: supabaseError || '',
        error: 'Supabase is not configured.'
      });
      return;
    }

    const normalized = normalizeConversation(body);
    if (normalized.turnCount === 0) {
      res.status(422).json({
        ok: false,
        saved: false,
        reason: 'empty_chat',
        error: 'There is no chat content to keep.'
      });
      return;
    }

    const now = new Date().toISOString();
    const row = {
      account_provider: identity.accountProvider,
      account_id: identity.accountId,
      account_id_hash: hashIdentifier(`${identity.accountProvider}:${identity.accountId}`),
      email: identity.email,
      name: identity.name,
      title: normalized.title,
      system_mode: normalized.systemMode,
      turn_count: normalized.turnCount,
      citation_count: normalized.citationCount,
      conversation: normalized.conversation,
      created_at: now,
      updated_at: now
    };

    const { data, error } = await supabase
      .from('search_chat_keeps')
      .insert(row)
      .select('id, created_at')
      .single();

    if (error) {
      const reason = isMissingTableError(error)
        ? 'schema_missing'
        : isMissingColumnError(error)
        ? 'schema_incomplete'
        : 'supabase_write_failed';
      try {
        const storage = await persistSearchKeepToStorage({ supabase, row, normalized });
        res.status(200).json({
          ok: true,
          saved: true,
          persisted: true,
          storage: true,
          keepId: storage.path,
          storageBucket: storage.bucket,
          createdAt: storage.createdAt,
          title: normalized.title,
          fallbackFrom: reason
        });
        return;
      } catch (storageError) {
        res.status(200).json({
          ok: false,
          saved: false,
          persisted: false,
          localFallbackAllowed: true,
          reason: 'supabase_storage_failed',
          dbReason: reason,
          detail: storageError && storageError.message ? storageError.message : error.message || '',
          error: 'Could not save this chat to Supabase.'
        });
        return;
      }
    }

    res.status(200).json({
      ok: true,
      saved: true,
      keepId: data && data.id ? data.id : '',
      createdAt: data && data.created_at ? data.created_at : now,
      title: normalized.title
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      saved: false,
      error: error && error.message ? error.message : 'Could not keep this chat.'
    });
  }
}

export default sendSearchChatKeepResponse;
