import { proxyHelperRequest, sendMethodNotAllowed } from '../../lib/helper-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, ['GET']);
    return;
  }
  await proxyHelperRequest(req, res, '/api/helper/info');
}
