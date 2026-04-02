import { proxyDistributedHelperOperation, sendMethodNotAllowed } from '../../lib/helper-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }
  await proxyDistributedHelperOperation(req, res, '/api/helper/convert');
}
