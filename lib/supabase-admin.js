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
  const inferredUrl = inferSupabaseUrlFromJwtKeys([anonKey, serviceRoleKey]);
  const url = explicitUrl || inferredUrl;

  return {
    url,
    urlSource: explicitUrl ? 'env' : (inferredUrl ? 'jwt-ref' : ''),
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
      ? ' A public anon key is present, but helper planning still requires a server-side service-role key.'
      : ' BlueMode UI may expose only public values; the helper still requires a server-side service-role key.';
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
