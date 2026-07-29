import './lib/local-env.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { sendBountyCheckoutResponse } from './lib/bounty-checkout.js';
import { sendEmailVerificationResponse } from './lib/email-verification.js';
import { sendStripeSetupResponse } from './lib/stripe-setup.js';
import blueAuthLogin from './api/blue-auth-login.js';
import blueAuthLogout from './api/blue-auth-logout.js';
import blueAuthSignup from './api/blue-auth-signup.js';
import checkLogin from './api/check-login.js';
import cookieConsent from './api/cookie-consent.js';
import googleApi from './api/google.js';
import jscoqProxy from './api/jscoq-proxy.js';
import suggest from './api/suggest.js';
import {
  canUseLocalExecutionFallback,
  isExecutionConfigured as isRemoteExecutionConfigured,
  proxyCompositeHelperInfo,
  proxyDistributedCheck,
  proxyDistributedHelperOperation,
  proxyExecutionApiRequest,
  proxyHelperRequest as proxyHelperRouteRequest,
  sendRemoteConfigurationError
} from './lib/helper-proxy.js';
import { sendAttachmentCompleteResponse, sendAttachmentUploadPlanResponse } from './lib/problem-attachments.js';
import { sendPersistedProblemResponse } from './lib/problem-store.js';
import { sendProofAiResponse } from './lib/proof-ai.js';
import { sendProofConversionResponse } from './lib/proof-convert.js';
import { sendProofCheckResponse } from './lib/proof-check.js';
import { sendSearchChatKeepResponse } from './lib/search-chat-keep.js';
import { verifyJobCapability } from './lib/job-access.js';
import { assertExecutionRequestAuthorized } from './lib/execution-auth.js';
import { assertProofSandboxRuntimeAvailable } from './lib/child-process-tree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const EXECUTION_RECEIVER_MODE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.EXECUTION_RECEIVER_MODE || '').trim().toLowerCase()
);

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; connect-src 'self' https: wss:; frame-src 'self' blob: data: https://accounts.google.com https://checkout.stripe.com https://billing.stripe.com https://link.com; worker-src 'self' blob:; form-action 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Origin-Agent-Cluster', '?1');
  next();
});
app.use(express.json({
  limit: '512kb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true, limit: '128kb' }));

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.status(Number(error && (error.statusCode || error.status)) || 500).json({
        error: 'Server error',
        detail: process.env.NODE_ENV === 'production'
          ? undefined
          : (error && error.message ? error.message : String(error))
      });
    }
  };
}

function assertLocalJobAccess(req, res) {
  const token = String(req.headers['x-ivucx-job-token'] || req.query.jobToken || '').trim();
  if (verifyJobCapability(req.params.id, token)) return true;
  res.status(403).json({ ok: false, error: 'Helper job access is not authorized.' });
  return false;
}

function googleRoute(route) {
  return (req, res) => {
    req.query = req.query || {};
    req.query.route = route;
    return googleApi(req, res);
  };
}

app.post('/api/lean-check', wrap(async (req, res) => {
  if (!EXECUTION_RECEIVER_MODE && isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/lean-check');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await assertExecutionRequestAuthorized(req);
  await sendProofCheckResponse('lean', req, res);
}));

app.post('/api/coq-check', wrap(async (req, res) => {
  if (!EXECUTION_RECEIVER_MODE && isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/coq-check');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await assertExecutionRequestAuthorized(req);
  await sendProofCheckResponse('coq', req, res);
}));

app.post('/api/proof-convert', wrap(async (req, res) => {
  if (!EXECUTION_RECEIVER_MODE && isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/proof-convert');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await assertExecutionRequestAuthorized(req);
  await sendProofConversionResponse(req, res);
}));

app.get('/api/helper/info', wrap((req, res) => proxyCompositeHelperInfo(req, res)));
app.get('/api/helper/schema-check', wrap((req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  return proxyHelperRouteRequest(req, res, '/api/helper/schema-check');
}));
app.post('/api/helper/check', wrap((req, res) => proxyDistributedCheck(req, res)));
app.post('/api/helper/submit', wrap((req, res) => proxyDistributedHelperOperation(req, res, '/api/helper/submit')));
app.post('/api/helper/convert', wrap((req, res) => proxyDistributedHelperOperation(req, res, '/api/helper/convert')));
app.post('/api/helper/persist', wrap((req, res) => sendPersistedProblemResponse(req, res)));
app.post('/api/helper/attachments/sign', wrap((req, res) => sendAttachmentUploadPlanResponse(req, res)));
app.post('/api/helper/attachments/complete', wrap((req, res) => sendAttachmentCompleteResponse(req, res)));
app.post('/api/helper/jobs', wrap((req, res) => proxyHelperRouteRequest(req, res, '/api/helper/jobs')));
app.get('/api/helper/jobs', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('/api/helper/jobs/:id', wrap((req, res) => {
  if (!assertLocalJobAccess(req, res)) return;
  return proxyHelperRouteRequest(req, res, `/api/helper/jobs/${encodeURIComponent(req.params.id)}`);
}));
app.get('/api/helper/jobs/:id/result', wrap((req, res) => {
  if (!assertLocalJobAccess(req, res)) return;
  return proxyHelperRouteRequest(req, res, `/api/helper/jobs/${encodeURIComponent(req.params.id)}/result`);
}));
app.delete('/api/helper/jobs/:id', (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Method not allowed' }));

app.get('/api/jscoq/*', wrap((req, res) => {
  req.query = req.query || {};
  req.query.path = req.params[0];
  return jscoqProxy(req, res);
}));

app.all('/api/blue-auth-signup', wrap(blueAuthSignup));
app.all('/api/blue-auth-login', wrap(blueAuthLogin));
app.all('/api/blue-auth-logout', wrap(blueAuthLogout));
app.all('/api/bounty-checkout', wrap(sendBountyCheckoutResponse));
app.all('/api/check-login', wrap(checkLogin));
app.all('/api/cookie-consent', wrap(cookieConsent));
app.all('/api/email-verification', wrap(sendEmailVerificationResponse));
app.all('/api/google', wrap(googleApi));
app.all('/api/google-auth-start', wrap(googleRoute('auth-start')));
app.all('/api/google-auth-callback', wrap(googleRoute('auth-callback')));
app.all('/api/google-files', wrap(googleRoute('files')));
app.all('/api/google-import', wrap(googleRoute('import')));
app.all('/api/google-one-tap', wrap(googleRoute('one-tap')));
app.all('/api/google-status', wrap(googleRoute('status')));
app.all('/api/proof-ai', wrap(sendProofAiResponse));
app.all('/api/stripe-setup', wrap(sendStripeSetupResponse));
app.all('/api/suggest', wrap(suggest));
app.all('/api/search-chat-keep', wrap(sendSearchChatKeepResponse));

const PRIVATE_PATH_PREFIXES = [
  '/api/', '/lib/', '/supabase/', '/docs/', '/desktop/', '/server-tools/',
  '/services/', '/scripts/', '/tests/', '/lean/', '/node_modules/', '/release/',
  '/.vercel/', '/.vscode/'
];
const PRIVATE_ROOT_FILES = new Set([
  '/package.json', '/package-lock.json', '/vercel.json', '/dockerfile', '/render.yaml',
  '/readme.md', '/index.js', '/.gitignore', '/.vercelignore', '/.dockerignore', '/.npmrc'
]);
app.use((req, res, next) => {
  const requestPath = String(req.path || '').toLowerCase();
  if (
    PRIVATE_PATH_PREFIXES.some((prefix) => requestPath.startsWith(prefix))
    || PRIVATE_ROOT_FILES.has(requestPath)
    || requestPath.startsWith('/.git')
    || requestPath.startsWith('/.env')
  ) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  next();
});

app.use(express.static(__dirname, { dotfiles: 'ignore', extensions: ['html'] }));

app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0';
if (EXECUTION_RECEIVER_MODE) {
  await assertProofSandboxRuntimeAvailable();
}
const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const host = address && typeof address === 'object' ? address.address : HOST;
  const port = address && typeof address === 'object' ? address.port : PORT;
  console.log(`[ivucx] server listening on ${host}:${port}`);
});

server.on('error', (error) => {
  console.error('[ivucx] server failed to bind', error);
});

process.on('uncaughtException', (error) => {
  console.error('[ivucx] uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ivucx] unhandled rejection', reason);
});
