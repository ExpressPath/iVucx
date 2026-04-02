import { isExecutionConfigured, proxyExecutionApiRequest, sendMethodNotAllowed } from '../lib/helper-proxy.js';
import { sendProofCheckResponse } from '../lib/proof-check.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }

  if (isExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/lean-check');
    return;
  }

  await sendProofCheckResponse('lean', req, res);
}
