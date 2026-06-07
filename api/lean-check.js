import {
  canUseLocalExecutionFallback,
  isExecutionConfigured,
  proxyExecutionProofCheckRequest,
  sendMethodNotAllowed,
  sendRemoteConfigurationError
} from '../lib/helper-proxy.js';
import { sendProofCheckResponse } from '../lib/proof-check.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }

  if (isExecutionConfigured()) {
    await proxyExecutionProofCheckRequest(req, res, '/api/lean-check');
    return;
  }

  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }

  await sendProofCheckResponse('lean', req, res);
}
