import { createClient } from '@supabase/supabase-js';

let cachedClient = null;

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function inferSupabaseUrlFromJwtKeys(keys) {
  for (const key of keys) {
    const payload = decodeJwtPayload(key);
    const ref = payload && typeof payload.ref === 'string' ? payload.ref.trim() : '';
    if (/^[a-z0-9-]{10,}$/.test(ref)) {
      return `https://${ref}.supabase.co`;
    }
  }
  return '';
}

function normalizeSupabaseProjectRef(value) {
  const ref = String(value || '').trim().toLowerCase();
  return /^[a-z0-9-]{10,}$/.test(ref) ? ref : '';
}

function inferSupabaseUrlFromProjectRef(value) {
  const ref = normalizeSupabaseProjectRef(value);
  return ref ? `https://${ref}.supabase.co` : '';
}

function inferSupabaseUrlFromDatabaseUrls(values) {
  for (const value of values) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) continue;

    try {
      const parsed = new URL(raw);
      const host = parsed.hostname || '';
      const directHostMatch = host.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
      if (directHostMatch) {
        const directRef = normalizeSupabaseProjectRef(directHostMatch[1]);
        if (directRef) return `https://${directRef}.supabase.co`;
      }

      const username = decodeURIComponent(parsed.username || '');
      const userRefMatch = username.match(/(?:^|\.)([a-z0-9-]{10,})$/i);
      if (userRefMatch) {
        const userRef = normalizeSupabaseProjectRef(userRefMatch[1]);
        if (userRef) return `https://${userRef}.supabase.co`;
      }
    } catch (error) {
      // Ignore malformed database URLs and keep checking other env values.
    }
  }

  return '';
}

export function resolveSupabaseAdminEnv() {
  const serviceRoleKey = firstNonEmpty([
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.SUPABASE_SERVICE_ROLE,
    process.env.SUPABASE_SECRET_KEY
  ]);
  const anonKey = firstNonEmpty([
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_ANON_KEY
  ]);
  const explicitUrl = firstNonEmpty([
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL
  ]);
  const explicitProjectRef = firstNonEmpty([
    process.env.SUPABASE_PROJECT_REF,
    process.env.SUPABASE_PROJECT_ID,
    process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF,
    process.env.NEXT_PUBLIC_SUPABASE_PROJECT_ID,
    process.env.VITE_SUPABASE_PROJECT_REF
  ]);
  const inferredUrl = inferSupabaseUrlFromJwtKeys([anonKey, serviceRoleKey]);
  const projectRefUrl = inferSupabaseUrlFromProjectRef(explicitProjectRef);
  const databaseUrl = inferSupabaseUrlFromDatabaseUrls([
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.DATABASE_URL
  ]);
  const url = explicitUrl || projectRefUrl || inferredUrl || databaseUrl;

  return {
    url,
    urlSource: explicitUrl
      ? 'env'
      : projectRefUrl
      ? 'project-ref'
      : inferredUrl
      ? 'jwt-ref'
      : (databaseUrl ? 'database-url' : ''),
    serviceRoleKey,
    anonKey
  };
}

export function getSupabaseAdmin() {
  const { url, serviceRoleKey, anonKey } = resolveSupabaseAdminEnv();

  if (!url || !serviceRoleKey) {
    const missing = [];
    if (!url) {
      missing.push('NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)');
    }
    if (!serviceRoleKey) {
      missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)');
    }

    const anonNote = anonKey
      ? ' A public anon key is present, but server-side Supabase access still needs a project URL and a service-role key.'
      : ' Browser-safe public values are not enough for server-side Supabase access.';
    return {
      client: null,
      error: `Supabase environment variables are missing. Set ${missing.join(' and ')}.${anonNote}`
    };
  }

  if (!cachedClient) {
    cachedClient = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  return { client: cachedClient, error: null };
}
