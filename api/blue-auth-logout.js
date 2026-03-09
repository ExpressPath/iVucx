import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  buildClearSessionCookie,
  hashSessionToken,
  readSessionFromRequest
} from '../lib/blue-auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawSession = readSessionFromRequest(req);
  const { client: supabase } = getSupabaseAdmin();

  if (rawSession && supabase) {
    const tokenHash = hashSessionToken(rawSession);
    await supabase
      .from('blue_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('session_token_hash', tokenHash)
      .is('revoked_at', null);
  }

  res.setHeader('Set-Cookie', buildClearSessionCookie());
  res.status(200).json({ ok: true });
}
