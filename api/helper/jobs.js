import {
  buildHelperQuery,
  proxyHelperRequest,
  sendMethodNotAllowed
} from '../../lib/helper-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendMethodNotAllowed(res, ['GET', 'POST']);
    return;
  }
  const query = req.method === 'GET' ? buildHelperQuery(req.query) : '';
  await proxyHelperRequest(req, res, '/api/helper/jobs' + query);
}
