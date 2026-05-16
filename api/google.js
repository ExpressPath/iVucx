import {
  googleAuthCallbackHandler,
  googleAuthStartHandler,
  googleFilesHandler,
  googleImportHandler,
  googleStatusHandler
} from '../lib/google-oauth.js';

const ROUTES = {
  'auth-start': googleAuthStartHandler,
  'auth-callback': googleAuthCallbackHandler,
  files: googleFilesHandler,
  import: googleImportHandler,
  status: googleStatusHandler
};

function readRoute(req) {
  const queryRoute = req && req.query && typeof req.query.route === 'string'
    ? req.query.route
    : '';
  if (queryRoute) return queryRoute.replace(/^\/+|\/+$/g, '');

  const path = String((req && req.url) || '').split('?')[0].replace(/^\/+|\/+$/g, '');
  if (path.startsWith('api/google-')) return path.slice('api/google-'.length);
  if (path.startsWith('google-')) return path.slice('google-'.length);
  return path;
}

export default async function googleHandler(req, res) {
  const route = readRoute(req);
  const handler = ROUTES[route];
  if (!handler) {
    res.status(404).json({ error: 'Google API route not found.' });
    return;
  }
  await handler(req, res);
}
