export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const nowIso = new Date().toISOString();

  res.status(200).json({
    loggedIn: false,
    accountId: null,
    consent: 'accepted',
    updatedAt: nowIso,
    persisted: false,
    autoAccepted: true
  });
}
