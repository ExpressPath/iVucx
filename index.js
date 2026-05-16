import './lib/local-env.js';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import blueAuthLogin from './api/blue-auth-login.js';
import blueAuthLogout from './api/blue-auth-logout.js';
import blueAuthSignup from './api/blue-auth-signup.js';
import checkLogin from './api/check-login.js';
import cookieConsent from './api/cookie-consent.js';
import googleAuthCallback from './api/google-auth-callback.js';
import googleAuthStart from './api/google-auth-start.js';
import googleFiles from './api/google-files.js';
import googleImport from './api/google-import.js';
import googleStatus from './api/google-status.js';
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
import { sendProofConversionResponse } from './lib/proof-convert.js';
import { sendProofCheckResponse } from './lib/proof-check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      res.status(500).json({
        error: 'Server error',
        detail: error && error.message ? error.message : String(error)
      });
    }
  };
}

app.post('/api/lean-check', wrap(async (req, res) => {
  if (isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/lean-check');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await sendProofCheckResponse('lean', req, res);
}));

app.post('/api/coq-check', wrap(async (req, res) => {
  if (isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/coq-check');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await sendProofCheckResponse('coq', req, res);
}));

app.post('/api/proof-convert', wrap(async (req, res) => {
  if (isRemoteExecutionConfigured()) {
    await proxyExecutionApiRequest(req, res, '/api/proof-convert');
    return;
  }
  if (!canUseLocalExecutionFallback()) {
    sendRemoteConfigurationError(res, 'execution');
    return;
  }
  await sendProofConversionResponse(req, res);
}));

app.get('/api/helper/info', wrap((req, res) => proxyCompositeHelperInfo(req, res)));
app.get('/api/helper/schema-check', wrap((req, res) => proxyHelperRouteRequest(req, res, '/api/helper/schema-check')));
app.post('/api/helper/check', wrap((req, res) => proxyDistributedCheck(req, res)));
app.post('/api/helper/submit', wrap((req, res) => proxyDistributedHelperOperation(req, res, '/api/helper/submit')));
app.post('/api/helper/convert', wrap((req, res) => proxyDistributedHelperOperation(req, res, '/api/helper/convert')));
app.post('/api/helper/jobs', wrap((req, res) => proxyHelperRouteRequest(req, res, '/api/helper/jobs')));
app.get('/api/helper/jobs', wrap((req, res) => proxyHelperRouteRequest(req, res, req.originalUrl)));
app.get('/api/helper/jobs/:id', wrap((req, res) => proxyHelperRouteRequest(req, res, req.originalUrl)));
app.get('/api/helper/jobs/:id/result', wrap((req, res) => proxyHelperRouteRequest(req, res, req.originalUrl)));
app.delete('/api/helper/jobs/:id', wrap((req, res) => proxyHelperRouteRequest(req, res, req.originalUrl)));

app.get('/api/jscoq/*', wrap((req, res) => {
  req.query = req.query || {};
  req.query.path = req.params[0];
  return jscoqProxy(req, res);
}));

app.all('/api/blue-auth-signup', wrap(blueAuthSignup));
app.all('/api/blue-auth-login', wrap(blueAuthLogin));
app.all('/api/blue-auth-logout', wrap(blueAuthLogout));
app.all('/api/check-login', wrap(checkLogin));
app.all('/api/cookie-consent', wrap(cookieConsent));
app.all('/api/google-auth-start', wrap(googleAuthStart));
app.all('/api/google-auth-callback', wrap(googleAuthCallback));
app.all('/api/google-files', wrap(googleFiles));
app.all('/api/google-import', wrap(googleImport));
app.all('/api/google-status', wrap(googleStatus));
app.all('/api/suggest', wrap(suggest));

app.use(express.static(__dirname, { dotfiles: 'ignore', extensions: ['html'] }));

app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0';
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
