import { proxyHelperRequest, sendMethodNotAllowed } from '../../lib/helper-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }
  await proxyHelperRequest(req, res, '/api/helper/convert');
}
