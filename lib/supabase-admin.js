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

export function resolveSupabaseAdminEnv() {
  const url = firstNonEmpty([
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL
  ]);
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

  return {
    url,
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
