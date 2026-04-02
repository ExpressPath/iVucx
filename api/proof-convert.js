import { sendMethodNotAllowed } from '../lib/helper-proxy.js';
import { sendProofConversionResponse } from '../lib/proof-convert.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, ['POST']);
    return;
  }

  await sendProofConversionResponse(req, res);
}
