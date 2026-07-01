import crypto from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_SEARCH_ROWS = 500;
const MAX_CONTEXT_DOCS = 12;
const MAX_SOURCE_CHARS = 900;
const MAX_CIC_CHARS = 900;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 700;
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let vertexTokenCache = {
  cacheKey: '',
  accessToken: '',
  expiresAt: 0
};

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function getGeminiApiKey() {
  return safeString(
    process.env.GEMINI_API_KEY
      || process.env.GOOGLE_GEMINI_API_KEY
      || process.env.GOOGLE_GENERATIVE_AI_API_KEY
      || process.env.GOOGLE_API_KEY
      || process.env.GENAI_API_KEY
  );
}

function getGeminiModel() {
  return safeString(process.env.GEMINI_MODEL, DEFAULT_MODEL);
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getVertexConfig() {
  const serviceAccountJson = safeString(
    process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON
      || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  );
  const project = safeString(
    process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCP_PROJECT
      || process.env.GCLOUD_PROJECT
  );
  const location = safeString(
    process.env.GOOGLE_CLOUD_LOCATION
      || process.env.GEMINI_VERTEX_LOCATION
      || process.env.VERTEX_AI_LOCATION,
    'us-central1'
  );
  const model = safeString(
    process.env.GEMINI_VERTEX_MODEL
      || process.env.GEMINI_MODEL,
    DEFAULT_MODEL
  );
  return {
    enabled: isTruthyEnv(process.env.GEMINI_VERTEX_ENABLED) || Boolean(serviceAccountJson),
    serviceAccountJson,
    project,
    location,
    model
  };
}

function getGeminiProxyConfig() {
  const url = safeString(
    process.env.GEMINI_VERTEX_PROXY_URL
      || process.env.GEMINI_PROXY_URL
  );
  return {
    enabled: Boolean(url),
    url,
    key: safeString(
      process.env.GEMINI_VERTEX_PROXY_KEY
        || process.env.GEMINI_PROXY_KEY
    ),
    model: safeString(
      process.env.GEMINI_VERTEX_MODEL
        || process.env.GEMINI_MODEL,
      DEFAULT_MODEL
    )
  };
}

function getKindFromMode(mode) {
  const normalized = normalizeProblemKind(mode);
  if (normalized) return normalized;
  return String(mode || '').trim().toLowerCase() === 'q' ? 'problem' : 'theorem';
}

function normalizeProblemKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['problem', 'problems', 'unsolved', 'q'].includes(text)) return 'problem';
  if (['theorem', 'theorems', 'proof', 'proofs', 'solved', 'a'].includes(text)) return 'theorem';
  return '';
}

function getRequestTargetKind(body) {
  const source = isPlainObject(body) ? body : {};
  return normalizeProblemKind(
    source.targetKind
      || source.problemKind
      || source.searchKind
      || source.postKind
      || source.mode
  ) || getKindFromMode(source.mode);
}

function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-\u3040-\u30ff\u3400-\u9fff]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12);
}

function truncateText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function normalizeHistory(rawHistory) {
  const source = Array.isArray(rawHistory) ? rawHistory : [];
  return source
    .map((item) => {
      const entry = isPlainObject(item) ? item : {};
      const role = String(entry.role || '').trim().toLowerCase() === 'assistant'
        ? 'assistant'
        : 'user';
      const text = truncateText(entry.text || entry.content || entry.query || entry.answer, MAX_HISTORY_CHARS);
      return text ? { role, text } : null;
    })
    .filter(Boolean)
    .slice(-MAX_HISTORY_TURNS);
}

function stringifyPreview(value, limit) {
  if (value == null) return '';
  if (typeof value === 'string') return truncateText(value, limit);
  try {
    return truncateText(JSON.stringify(value), limit);
  } catch (error) {
    return '';
  }
}

function extractAttachmentNames(requestMeta) {
  const attachments = requestMeta && Array.isArray(requestMeta.attachments)
    ? requestMeta.attachments
    : [];
  return attachments
    .map((item) => safeString(item && (item.relativePath || item.fileName || item.title)))
    .filter(Boolean)
    .slice(0, 8);
}

function inferLegacyRowKind(row) {
  const title = String(row && row.title || '').toLowerCase();
  const fileName = String(row && row.file_name || '').toLowerCase();
  const source = String(row && row.source_code || '').toLowerCase();
  const normalized = stringifyPreview(row && row.normalized_term, MAX_CIC_CHARS).toLowerCase();
  const headerText = `${title} ${fileName}`;
  const fullText = `${headerText} ${source} ${normalized}`;

  if (/\b(problem|problems|exercise|exercises|conjecture|conjectures|unsolved|open problem)\b/.test(headerText)) {
    return 'problem';
  }
  if (/\b(theorem|theorems|lemma|lemmas|corollary|corollaries|proposition|propositions|proof|proofs)\b/.test(headerText)) {
    return 'theorem';
  }
  if (/\b(problem|exercise|conjecture|unsolved|open problem)\b/.test(fullText)) {
    return 'problem';
  }
  if (/\b(theorem|lemma|corollary|proposition)\b/.test(fullText)) {
    return 'theorem';
  }
  return '';
}

function readRowKind(row) {
  const requestMeta = isPlainObject(row.request_meta) ? row.request_meta : {};
  const adapterMeta = isPlainObject(row.adapter_meta) ? row.adapter_meta : {};
  const storedKind = normalizeProblemKind(
    requestMeta.problemKind
      || requestMeta.postKind
      || requestMeta.searchKind
      || adapterMeta.problemKind
      || adapterMeta.postKind
  );
  return storedKind || inferLegacyRowKind(row);
}

function scoreRow(row, terms, targetKind) {
  const rowKind = readRowKind(row);
  if (rowKind !== targetKind) return -1;

  const title = String(row.title || '').toLowerCase();
  const fileName = String(row.file_name || '').toLowerCase();
  const source = String(row.source_code || '').toLowerCase();
  const cic = stringifyPreview(row.normalized_term, MAX_CIC_CHARS).toLowerCase();
  const haystack = `${title} ${fileName} ${source} ${cic}`;

  let score = 4;
  if (terms.length === 0) score += 1;
  for (const term of terms) {
    if (title.includes(term)) score += 12;
    if (fileName.includes(term)) score += 4;
    if (source.includes(term)) score += 6;
    if (cic.includes(term)) score += 2;
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function buildCitation(row, index) {
  const requestMeta = isPlainObject(row.request_meta) ? row.request_meta : {};
  const title = safeString(row.title, 'Untitled');
  const sourcePreview = truncateText(row.source_code, MAX_SOURCE_CHARS);
  const cicPreview = stringifyPreview(row.normalized_term, MAX_CIC_CHARS);
  const quote = sourcePreview || cicPreview || title;
  return {
    id: `P${index + 1}`,
    problemId: row.id,
    title,
    fileName: safeString(row.file_name),
    language: safeString(row.language),
    createdAt: row.created_at || '',
    kind: readRowKind(row) || 'unknown',
    normalizedFormat: safeString(row.normalized_format),
    requestedFormat: safeString(requestMeta.requestedFormat),
    completedFormat: safeString(requestMeta.completedFormat),
    attachments: extractAttachmentNames(requestMeta),
    quote: truncateText(quote, 420)
  };
}

async function searchSavedProblems({ query, targetKind, limit, offset }) {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw new Error(error || 'Supabase is not configured.');
  }

  const { data, error: queryError } = await client
    .from('problems')
    .select('id,title,language,file_name,source_code,normalized_format,normalized_term,adapter_meta,request_meta,created_at')
    .order('created_at', { ascending: false })
    .limit(MAX_SEARCH_ROWS);

  if (queryError) {
    throw new Error(queryError.message || 'Failed to search saved problems.');
  }

  const terms = tokenize(query);
  const ranked = (Array.isArray(data) ? data : [])
    .map((row) => ({ row, score: scoreRow(row, terms, targetKind) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || String(b.row.created_at || '').localeCompare(String(a.row.created_at || '')));

  return {
    total: ranked.length,
    citations: ranked
      .slice(offset, offset + limit)
      .map((entry, index) => buildCitation(entry.row, offset + index))
  };
}

function buildGeminiPrompt({ query, targetKind, citations, history }) {
  const context = citations.map((item) => ({
    id: item.id,
    title: item.title,
    fileName: item.fileName,
    language: item.language,
    kind: item.kind,
    normalizedFormat: item.normalizedFormat,
    requestedFormat: item.requestedFormat,
    completedFormat: item.completedFormat,
    attachments: item.attachments,
    quote: item.quote
  }));
  const conversation = normalizeHistory(history);

  return [
    'You are the iVucx saved-problem search assistant.',
    `Search target: ${targetKind}.`,
    `User query: ${query}`,
    '',
    conversation.length
      ? `Recent chat history: ${JSON.stringify(conversation)}`
      : 'Recent chat history: []',
    '',
    'Use only the provided saved rows as sources.',
    'Answer in Japanese unless the user query is clearly in another language.',
    'Every factual claim about a saved problem/theorem must cite source ids like [P1].',
    'If no saved row supports an answer, say that the saved database does not contain enough information.',
    'Suggestions must be short follow-up searches that can help refine the same problem/theorem lookup.',
    'Return JSON only with this shape:',
    '{"answer":"string","suggestions":["string"],"usedCitationIds":["P1"]}',
    '',
    `Saved rows: ${JSON.stringify(context)}`
  ].join('\n');
}

function buildGeminiRequestBody({ query, targetKind, citations, history }) {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: buildGeminiPrompt({ query, targetKind, citations, history }) }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  };
}

function parseGeminiText(payload) {
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    const text = parts.map((part) => part && part.text).filter(Boolean).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function parseAnswerJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    return isPlainObject(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function parseServiceAccountJson(rawValue) {
  const raw = safeString(rawValue);
  if (!raw) {
    throw new Error('Vertex AI service account is not configured. Set GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON in Vercel.');
  }

  let text = raw;
  if (!text.trim().startsWith('{')) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch (error) {
      throw new Error('Vertex AI service account JSON is not valid JSON or base64 JSON.');
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Vertex AI service account JSON could not be parsed.');
  }

  const clientEmail = safeString(parsed.client_email);
  const privateKey = safeString(parsed.private_key).replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) {
    throw new Error('Vertex AI service account JSON is missing client_email or private_key.');
  }
  return {
    clientEmail,
    privateKey,
    tokenUri: safeString(parsed.token_uri, OAUTH_TOKEN_URL)
  };
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getVertexAccessToken(config) {
  const serviceAccount = parseServiceAccountJson(config.serviceAccountJson);
  const cacheKey = `${serviceAccount.clientEmail}|${serviceAccount.tokenUri}`;
  const nowMs = Date.now();
  if (
    vertexTokenCache.cacheKey === cacheKey
    && vertexTokenCache.accessToken
    && vertexTokenCache.expiresAt - 60000 > nowMs
  ) {
    return vertexTokenCache.accessToken;
  }

  const now = Math.floor(nowMs / 1000);
  const unsigned = [
    base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64Url(JSON.stringify({
      iss: serviceAccount.clientEmail,
      scope: VERTEX_SCOPE,
      aud: serviceAccount.tokenUri,
      iat: now,
      exp: now + 3600
    }))
  ].join('.');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(serviceAccount.privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const tokenResponse = await fetch(serviceAccount.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const payload = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok) {
    const message = payload && (payload.error_description || payload.error)
      ? payload.error_description || payload.error
      : `Vertex AI OAuth failed: ${tokenResponse.status}`;
    const error = new Error(message);
    error.status = tokenResponse.status;
    throw error;
  }

  const accessToken = safeString(payload && payload.access_token);
  if (!accessToken) {
    throw new Error('Vertex AI OAuth did not return an access token.');
  }
  vertexTokenCache = {
    cacheKey,
    accessToken,
    expiresAt: nowMs + (Number(payload.expires_in) || 3600) * 1000
  };
  return accessToken;
}

async function askVertexGemini({ query, targetKind, citations, history, config }) {
  if (!config.project) {
    throw new Error('Vertex AI project is not configured. Set GOOGLE_CLOUD_PROJECT in Vercel.');
  }
  const accessToken = await getVertexAccessToken(config);
  const project = encodeURIComponent(config.project);
  const location = encodeURIComponent(config.location);
  const model = encodeURIComponent(config.model);
  const url = `https://${config.location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildGeminiRequestBody({ query, targetKind, citations, history }))
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `Vertex AI Gemini failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload && payload.error && payload.error.code
      ? payload.error.code
      : response.status;
    throw error;
  }

  const text = parseGeminiText(payload);
  const parsed = parseAnswerJson(text);
  if (parsed) {
    return {
      answer: safeString(parsed.answer, text),
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.map((item) => safeString(item)).filter(Boolean)
        : [],
      usedCitationIds: Array.isArray(parsed.usedCitationIds)
        ? parsed.usedCitationIds.map((item) => safeString(item)).filter(Boolean)
        : []
    };
  }
  return { answer: text, suggestions: [], usedCitationIds: [] };
}

async function askGeminiProxy({ query, targetKind, citations, history, config }) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.key ? { 'x-ivucx-helper-key': config.key } : {})
    },
    body: JSON.stringify({
      model: config.model,
      requestBody: buildGeminiRequestBody({ query, targetKind, citations, history })
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error
      ? payload.error
      : `Gemini proxy failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = response.status;
    throw error;
  }

  const text = parseGeminiText(payload);
  const parsed = parseAnswerJson(text);
  if (parsed) {
    return {
      answer: safeString(parsed.answer, text),
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.map((item) => safeString(item)).filter(Boolean)
        : [],
      usedCitationIds: Array.isArray(parsed.usedCitationIds)
        ? parsed.usedCitationIds.map((item) => safeString(item)).filter(Boolean)
        : []
    };
  }
  return { answer: text, suggestions: [], usedCitationIds: [] };
}

async function askGemini({ query, targetKind, citations, history }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Gemini API is not configured. Set GEMINI_API_KEY in Vercel.');
  }

  const model = getGeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiRequestBody({ query, targetKind, citations, history }))
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `Gemini API failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.code = payload && payload.error && payload.error.code
      ? payload.error.code
      : response.status;
    throw error;
  }

  const text = parseGeminiText(payload);
  const parsed = parseAnswerJson(text);
  if (parsed) {
    return {
      answer: safeString(parsed.answer, text),
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.map((item) => safeString(item)).filter(Boolean)
        : [],
      usedCitationIds: Array.isArray(parsed.usedCitationIds)
        ? parsed.usedCitationIds.map((item) => safeString(item)).filter(Boolean)
        : []
    };
  }
  return { answer: text, suggestions: [], usedCitationIds: [] };
}

async function askConfiguredGemini({ query, targetKind, citations, history }) {
  const proxyConfig = getGeminiProxyConfig();
  if (proxyConfig.enabled) {
    return {
      generated: await askGeminiProxy({ query, targetKind, citations, history, config: proxyConfig }),
      model: `vertex-proxy:${proxyConfig.model}`
    };
  }

  const vertexConfig = getVertexConfig();
  if (vertexConfig.enabled) {
    return {
      generated: await askVertexGemini({ query, targetKind, citations, history, config: vertexConfig }),
      model: `vertex:${vertexConfig.location}/${vertexConfig.model}`
    };
  }

  return {
    generated: await askGemini({ query, targetKind, citations, history }),
    model: getGeminiModel()
  };
}

function legacyDescribeGeminiFallbackReason(error) {
  const status = Number(error && (error.status || error.code));
  if (status === 429) {
    return 'Gemini API が現在レート制限またはクォータ上限に達しているため';
  }
  if (status === 400 || status === 401 || status === 403) {
    return 'Gemini API の認証またはプロジェクト設定で拒否されたため';
  }
  if (error && /not configured/i.test(String(error.message || ''))) {
    return 'Gemini API キーが未設定のため';
  }
  return 'Gemini API が一時的に利用できないため';
}

function legacyBuildFallbackAnswer(query, targetKind, citations, geminiError) {
  const reason = legacyDescribeGeminiFallbackReason(geminiError);
  if (citations.length === 0) {
    return {
      answer: `${reason}、保存済みの${targetKind === 'problem' ? '問題' : '定理'}から検索しましたが「${query}」に十分一致する情報が見つかりませんでした。`,
      suggestions: [],
      usedCitationIds: []
    };
  }

  const lines = citations.slice(0, 4).map((item) => {
    const file = item.fileName ? ` (${item.fileName})` : '';
    return `${item.title}${file}: ${item.quote} [${item.id}]`;
  });
  return {
    answer: `${reason}、保存済みデータから一致度の高い引用を返します。\n${lines.join('\n')}`,
    suggestions: citations.map((item) => `${item.title} [${item.id}]`),
    usedCitationIds: citations.map((item) => item.id)
  };
}

function describeGeminiFallbackReason(error) {
  const status = Number(error && (error.status || error.code));
  if (status === 429) {
    return 'Gemini API が現在レート制限またはクォータ上限に達しているため';
  }
  if (status === 400 || status === 401 || status === 403) {
    return 'Gemini API の認証またはプロジェクト設定で拒否されたため';
  }
  if (error && /not configured/i.test(String(error.message || ''))) {
    return 'Gemini API の接続情報が未設定のため';
  }
  return 'Gemini API が一時的に利用できないため';
}

function buildFallbackAnswer(query, targetKind, citations, geminiError) {
  const reason = describeGeminiFallbackReason(geminiError);
  if (citations.length === 0) {
    return {
      answer: `${reason}、保存済みの${targetKind === 'problem' ? '問題' : '定理'}から検索しましたが、「${query}」に十分一致する情報が見つかりませんでした。`,
      suggestions: [],
      usedCitationIds: []
    };
  }

  const lines = citations.slice(0, 4).map((item) => {
    const file = item.fileName ? ` (${item.fileName})` : '';
    return `${item.title}${file}: ${item.quote} [${item.id}]`;
  });
  return {
    answer: `${reason}、保存済みデータから一致度の高い引用を返します。\n${lines.join('\n')}`,
    suggestions: citations.map((item) => `${item.title} [${item.id}]`),
    usedCitationIds: citations.map((item) => item.id)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const query = safeString(body.query);
    const mode = safeString(body.mode, 'a');
    const limit = clamp(Number(body.limit) || 6, 1, 10);
    const offset = clamp(Number(body.offset) || 0, 0, 5000);
    const history = normalizeHistory(body.history);
    const includeAnswer = body.includeAnswer !== false;
    const targetKind = getRequestTargetKind(body);
    const pageSize = Math.max(limit, MAX_CONTEXT_DOCS);
    const searchResult = await searchSavedProblems({ query, targetKind, limit: pageSize, offset });
    const context = searchResult.citations.slice(0, MAX_CONTEXT_DOCS);

    let generated;
    let model = getGeminiModel();
    let geminiUsed = false;
    if (includeAnswer) {
      try {
        const geminiResult = await askConfiguredGemini({ query, targetKind, citations: context, history });
        generated = geminiResult.generated;
        model = geminiResult.model;
        geminiUsed = true;
      } catch (geminiError) {
        generated = buildFallbackAnswer(query, targetKind, context, geminiError);
        model = '';
      }
    } else {
      generated = {
        answer: '',
        suggestions: context.map((item) => `${item.title} [${item.id}]`),
        usedCitationIds: []
      };
      model = '';
    }

    const suggestions = generated.suggestions && generated.suggestions.length
      ? generated.suggestions
      : context.map((item) => `${item.title} [${item.id}]`);
    const usedCitationIds = Array.isArray(generated.usedCitationIds)
      ? generated.usedCitationIds.map((item) => safeString(item)).filter(Boolean)
      : [];
    const usedSet = new Set(usedCitationIds);
    const citations = context.map((item) => ({
      ...item,
      used: usedSet.has(item.id)
    }));

    res.status(200).json({
      mode,
      targetKind,
      query,
      offset,
      model,
      geminiUsed,
      answer: generated.answer,
      citations,
      usedCitationIds,
      suggestions: suggestions.slice(0, limit),
      hasMore: offset + searchResult.citations.length < searchResult.total
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || 'Problem search failed.'
    });
  }
}
