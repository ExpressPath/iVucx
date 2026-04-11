import {
  canUseLocalExecutionFallback,
  isExecutionConfigured,
  proxyExecutionApiRequest,
  sendMethodNotAllowed,
  sendRemoteConfigurationError
} from '../lib/helper-proxy.js';
import { sendProofConversionResponse } from '../lib/proof-convert.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }

  if (isExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/proof-convert');
    return;
  }

  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }

  await sendProofConversionResponse(req, res);
}
