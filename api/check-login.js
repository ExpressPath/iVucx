import { getGoogleIdentity } from '../lib/google-oauth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const identity = await getGoogleIdentity(req);
  if (!identity.authenticated) {
    res.status(200).json({
      loggedIn: false,
      rewards: [],
      provider: 'google',
      reason: 'no_google_session'
    });
    return;
  }

  res.status(200).json({
    loggedIn: true,
    accountId: identity.accountId,
    email: identity.email,
    name: identity.name,
    rewards: [],
    provider: 'google',
    cookieConsent: 'unknown',
    cookieConsentUpdatedAt: null,
    reason: 'ok'
  });
}
