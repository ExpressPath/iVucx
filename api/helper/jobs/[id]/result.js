import {
  proxyHelperRequest,
  sendMethodNotAllowed
} from '../../../../lib/helper-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, ['GET']);
    return;
  }

  const id = req.query && typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) {
    res.status(400).json({ error: 'Job id is required' });
    return;
  }

  await proxyHelperRequest(req, res, '/api/helper/jobs/' + encodeURIComponent(id) + '/result');
}
