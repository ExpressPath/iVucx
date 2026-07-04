import { createHash } from 'node:crypto';
import { hashSessionToken, readSessionFromRequest } from './blue-auth.js';
import { getGoogleIdentity } from './google-oauth.js';
import { getSupabaseAdmin } from './supabase-admin.js';

const MAX_CODE_CHARS = 24000;
const MAX_OUTPUT_CHARS = 12000;
const MAX_PROMPT_CHARS = 6000;
const MAX_FILES = 12;
const MAX_EXTERNAL_CONTEXT_CHARS = 12000;
const DEFAULT_MAX_TOKENS = 1800;
const CONTEXT_TIMEOUT_MS = 8000;

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function utcNowIso() {
  return new Date().toISOString();
}

function hashIdentifier(value) {
  const text = safeString(value);
  return text ? createHash('sha256').update(text).digest('hex') : '';
}

function truncateText(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24)).trimEnd()}\n...[truncated]`;
}

function normalizeProvider(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['deepseek-v4', 'deepseek_v4', 'deepseek'].includes(text)) return 'deepseek-v4';
  if (['deepseek-prover', 'deepseek_prover', 'prover'].includes(text)) return 'deepseek-prover';
  if (['chatgpt', 'openai', 'gpt'].includes(text)) return 'chatgpt';
  if (['claude', 'anthropic'].includes(text)) return 'claude';
  return 'chatgpt';
}

function normalizeLanguage(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'coq') return 'Coq';
  if (text === 'lean') return 'Lean';
  if (text === 'isabelle') return 'Isabelle';
  if (text === 'agda') return 'Agda';
  return 'Lean';
}

function normalizeContextEngine(value, language) {
  const text = String(value || '').trim().toLowerCase();
  const known = new Set(['auto', 'coq-lsp', 'pycoq', 'lean-repl', 'leandojo']);
  if (known.has(text)) return text;
  return language === 'Coq' ? 'coq-lsp' : 'lean-repl';
}

function firstEnv(names) {
  for (const name of names) {
    const value = safeString(process.env[name]);
    if (value) return value;
  }
  return '';
}

function providerConfig(provider) {
  if (provider === 'deepseek-v4') {
    return {
      provider,
      label: 'DeepSeek-V4',
      transport: 'openai-compatible',
      baseUrl: safeString(process.env.DEEPSEEK_V4_API_BASE_URL || process.env.DEEPSEEK_API_BASE_URL, 'https://api.deepseek.com'),
      endpoint: safeString(process.env.DEEPSEEK_V4_CHAT_PATH || process.env.DEEPSEEK_CHAT_PATH, '/chat/completions'),
      model: safeString(process.env.DEEPSEEK_V4_MODEL || process.env.DEEPSEEK_MODEL, 'deepseek-v4-flash'),
      apiKey: firstEnv(['DEEPSEEK_V4_API_KEY', 'DEEPSEEK_API_KEY'])
    };
  }

  if (provider === 'deepseek-prover') {
    return {
      provider,
      label: 'DeepSeek-Prover',
      transport: 'openai-compatible',
      baseUrl: safeString(process.env.DEEPSEEK_PROVER_API_BASE_URL || process.env.DEEPSEEK_API_BASE_URL, 'https://api.deepseek.com'),
      endpoint: safeString(process.env.DEEPSEEK_PROVER_CHAT_PATH || process.env.DEEPSEEK_CHAT_PATH, '/chat/completions'),
      model: safeString(process.env.DEEPSEEK_PROVER_MODEL, 'deepseek-v4-pro'),
      apiKey: firstEnv(['DEEPSEEK_PROVER_API_KEY', 'DEEPSEEK_API_KEY'])
    };
  }

  if (provider === 'claude') {
    return {
      provider,
      label: 'Claude',
      transport: 'anthropic',
      baseUrl: safeString(process.env.ANTHROPIC_API_BASE_URL, 'https://api.anthropic.com'),
      endpoint: safeString(process.env.ANTHROPIC_MESSAGES_PATH, '/v1/messages'),
      model: safeString(process.env.ANTHROPIC_MODEL, 'claude-sonnet-4-5'),
      apiKey: firstEnv(['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'])
    };
  }

  return {
    provider: 'chatgpt',
    label: 'ChatGPT',
    transport: 'openai-compatible',
    baseUrl: safeString(process.env.OPENAI_API_BASE_URL, 'https://api.openai.com/v1'),
    endpoint: safeString(process.env.OPENAI_CHAT_PATH, '/chat/completions'),
    model: safeString(process.env.OPENAI_MODEL, 'gpt-5.4-mini'),
    apiKey: firstEnv(['OPENAI_API_KEY', 'CHATGPT_API_KEY'])
  };
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
  const now = utcNowIso();
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

async function getProofAiAccountIdentity(req, supabase) {
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

async function registerProofAiProvider(req, res, body) {
  const { client: supabase, error: supabaseError } = getSupabaseAdmin();
  const identity = await getProofAiAccountIdentity(req, supabase);
  const provider = normalizeProvider(body.provider);
  const language = normalizeLanguage(body.language);
  const contextEngine = normalizeContextEngine(body.contextEngine, language);
  const config = providerConfig(provider);
  const model = safeString(body.model, config.model);
  const keySource = safeString(body.keySource, body.hasLocalKey ? 'browser-local' : 'server-env');
  const now = utcNowIso();

  if (!identity.authenticated) {
    res.status(200).json({
      ok: true,
      linked: false,
      loggedIn: false,
      reason: 'not_logged_in',
      provider,
      label: config.label,
      model,
      contextEngine
    });
    return;
  }

  if (!supabase) {
    res.status(200).json({
      ok: true,
      linked: false,
      loggedIn: true,
      reason: 'supabase_unavailable',
      detail: supabaseError || '',
      accountId: identity.accountId,
      accountProvider: identity.accountProvider,
      provider,
      label: config.label,
      model,
      contextEngine
    });
    return;
  }

  const row = {
    account_provider: identity.accountProvider,
    account_id: identity.accountId,
    account_id_hash: hashIdentifier(`${identity.accountProvider}:${identity.accountId}`),
    email: identity.email,
    name: identity.name,
    provider,
    provider_label: config.label,
    model,
    context_engine: contextEngine,
    language,
    key_source: keySource,
    approved: true,
    approved_at: now,
    updated_at: now
  };

  const { error } = await supabase
    .from('proof_ai_agent_accounts')
    .upsert(row, { onConflict: 'account_provider,account_id,provider' });

  if (error) {
    res.status(200).json({
      ok: true,
      linked: false,
      loggedIn: true,
      reason: isMissingTableError(error)
        ? 'schema_missing'
        : isMissingColumnError(error)
        ? 'schema_incomplete'
        : 'supabase_write_failed',
      detail: error.message || '',
      accountId: identity.accountId,
      accountProvider: identity.accountProvider,
      provider,
      label: config.label,
      model,
      contextEngine
    });
    return;
  }

  res.status(200).json({
    ok: true,
    linked: true,
    loggedIn: true,
    accountId: identity.accountId,
    accountProvider: identity.accountProvider,
    provider,
    label: config.label,
    model,
    contextEngine,
    keySource
  });
}

function contextEndpointForEngine(contextEngine) {
  const key = String(contextEngine || '').trim().toLowerCase().replace(/-/g, '_');
  const specific = {
    coq_lsp: process.env.COQ_LSP_CONTEXT_API_URL,
    pycoq: process.env.PYCOQ_CONTEXT_API_URL,
    lean_repl: process.env.LEAN_REPL_CONTEXT_API_URL,
    leandojo: process.env.LEANDOJO_CONTEXT_API_URL
  };
  return safeString(
    specific[key]
      || process.env.PROOF_AI_CONTEXT_API_URL
      || process.env.PROOF_CONTEXT_API_URL
  );
}

function joinUrl(baseUrl, endpoint) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(endpoint || '').startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .slice(0, MAX_FILES)
    .map((file, index) => ({
      name: safeString(file && file.name, `File ${index + 1}`),
      path: safeString(file && file.path),
      language: safeString(file && file.language),
      active: Boolean(file && file.active),
      code: truncateText(file && file.code, MAX_CODE_CHARS)
    }));
}

function buildMessages({ body, config, language, contextEngine, externalContext }) {
  const prompt = truncateText(safeString(body.prompt), MAX_PROMPT_CHARS);
  const code = truncateText(body.code, MAX_CODE_CHARS);
  const validationOutput = truncateText(body.validationOutput, MAX_OUTPUT_CHARS);
  const files = normalizeFiles(body.files);
  const activeFileName = safeString(body.fileName, language === 'Coq' ? 'Main.v' : 'Main.lean');
  const proofKind = safeString(body.problemKind, 'theorem');

  const system = [
    'You are an expert proof-assistant AI for iVucx.',
    'Help the user write, debug, and search proof strategies for formal mathematics.',
    'Never claim a proof is verified unless the provided server output says so.',
    'Prefer concrete Coq/Lean code, next tactics, goal analysis, and small edits.',
    'If the proof context is incomplete, say exactly what extra goal/state information is needed.',
    'For Coq, interpret coq-lsp/pycoq context as goals, hypotheses, diagnostics, and command state.',
    'For Lean, interpret Lean REPL/LeanDojo context as goals, messages, imports, and tactic state.'
  ].join('\n');

  const user = [
    `Provider label: ${config.label}`,
    `Language: ${language}`,
    `Requested proof context engine: ${contextEngine}`,
    `Problem kind: ${proofKind}`,
    `Active file: ${activeFileName}`,
    '',
    'User prompt:',
    prompt || 'Help with the current proof.',
    '',
    'Latest validation / REPL output:',
    validationOutput || '(none yet)',
    '',
    'External proof-context adapter output:',
    externalContext || '(no external adapter configured; use editor code and latest validation output)',
    '',
    'Active editor code:',
    code || '(empty)',
    '',
    'Open proof files:',
    JSON.stringify(files, null, 2)
  ].join('\n');

  return { system, user };
}

async function fetchExternalProofContext({ body, language, contextEngine }) {
  const url = contextEndpointForEngine(contextEngine);
  if (!url) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(safeString(process.env.PROOF_AI_CONTEXT_API_KEY || process.env.PROOF_CONTEXT_API_KEY)
          ? { 'x-ivucx-helper-key': safeString(process.env.PROOF_AI_CONTEXT_API_KEY || process.env.PROOF_CONTEXT_API_KEY) }
          : {})
      },
      body: JSON.stringify({
        language,
        contextEngine,
        fileName: safeString(body.fileName),
        code: truncateText(body.code, MAX_CODE_CHARS),
        validationOutput: truncateText(body.validationOutput, MAX_OUTPUT_CHARS),
        files: normalizeFiles(body.files)
      })
    });
    const contentType = safeString(response.headers.get('content-type'));
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text().catch(() => '');
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && payload.error
        ? payload.error
        : `context adapter failed: ${response.status}`;
      return truncateText(`[${contextEngine}] ${message}`, MAX_EXTERNAL_CONTEXT_CHARS);
    }
    if (payload && typeof payload === 'object') {
      return truncateText(
        payload.context || payload.output || payload.stdout || payload.result || JSON.stringify(payload),
        MAX_EXTERNAL_CONTEXT_CHARS
      );
    }
    return truncateText(payload, MAX_EXTERNAL_CONTEXT_CHARS);
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'context adapter timed out'
      : (error && error.message ? error.message : 'context adapter unavailable');
    return truncateText(`[${contextEngine}] ${message}`, MAX_EXTERNAL_CONTEXT_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAiAnswer(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message && typeof message.content === 'string' ? message.content.trim() : '';
  const reasoning = message && typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '';
  if (content && reasoning) return `${reasoning}\n\n${content}`;
  return content || reasoning || '';
}

function extractAnthropicAnswer(payload) {
  const parts = Array.isArray(payload && payload.content) ? payload.content : [];
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function callOpenAiCompatible({ config, apiKey, model, messages }) {
  const response = await fetch(joinUrl(config.baseUrl, config.endpoint), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user }
      ],
      temperature: 0.2,
      max_tokens: DEFAULT_MAX_TOKENS
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error && (payload.error.message || payload.error)
      ? payload.error.message || payload.error
      : `AI provider failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return extractOpenAiAnswer(payload);
}

async function callAnthropic({ config, apiKey, model, messages }) {
  const response = await fetch(joinUrl(config.baseUrl, config.endpoint), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': safeString(process.env.ANTHROPIC_VERSION, '2023-06-01'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      system: messages.system,
      messages: [
        { role: 'user', content: messages.user }
      ],
      temperature: 0.2,
      max_tokens: DEFAULT_MAX_TOKENS
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && payload.error && (payload.error.message || payload.error)
      ? payload.error.message || payload.error
      : `Claude API failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return extractAnthropicAnswer(payload);
}

export async function sendProofAiResponse(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = readBody(req);
    if (safeString(body.action).toLowerCase() === 'register') {
      await registerProofAiProvider(req, res, body);
      return;
    }

    const provider = normalizeProvider(body.provider);
    const language = normalizeLanguage(body.language);
    const contextEngine = normalizeContextEngine(body.contextEngine, language);
    const config = providerConfig(provider);
    const apiKey = safeString(body.apiKey) || config.apiKey;
    const model = safeString(body.model, config.model);

    if (!apiKey) {
      res.status(401).json({
        error: `${config.label} API key is required.`,
        requiresApiKey: true,
        provider,
        label: config.label
      });
      return;
    }

    const externalContext = await fetchExternalProofContext({ body, language, contextEngine });
    const messages = buildMessages({ body, config, language, contextEngine, externalContext });
    const answer = config.transport === 'anthropic'
      ? await callAnthropic({ config, apiKey, model, messages })
      : await callOpenAiCompatible({ config, apiKey, model, messages });

    res.status(200).json({
      provider,
      label: config.label,
      model,
      contextEngine,
      answer: answer || '(empty response)'
    });
  } catch (error) {
    res.status(error && error.status ? error.status : 500).json({
      error: error && error.message ? error.message : 'AI request failed.'
    });
  }
}

export default sendProofAiResponse;
