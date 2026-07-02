import { sendStripeSetupResponse } from '../lib/stripe-setup.js';

export default async function handler(req, res) {
  await sendStripeSetupResponse(req, res);
}
