import { getIvucxAccountSnapshot } from '../lib/ivucx.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const snapshot = await getIvucxAccountSnapshot(req);
  const identity = snapshot.identity || {};
  if (!snapshot.loggedIn) {
    res.status(200).json({
      loggedIn: false,
      rewards: [],
      notifications: [],
      transactions: [],
      balance: snapshot.balance,
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
    rewards: snapshot.rewards || [],
    notifications: snapshot.notifications || [],
    transactions: snapshot.transactions || [],
    balance: snapshot.balance,
    provider: identity.accountProvider || 'google',
    cookieConsent: 'unknown',
    cookieConsentUpdatedAt: null,
    ivucxUnavailable: !!snapshot.unavailable,
    ivucxError: snapshot.unavailable ? 'Account data is temporarily unavailable.' : '',
    reason: 'ok'
  });
}
