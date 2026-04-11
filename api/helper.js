import {
  buildHelperQuery,
  proxyCompositeHelperInfo,
  proxyDistributedCheck,
  proxyDistributedHelperOperation,
  proxyHelperRequest,
  sendMethodNotAllowed
} from '../lib/helper-proxy.js';

function getRouteSegments(req) {
  const raw = req && req.query ? req.query.route : undefined;
  if (Array.isArray(raw)) {
    return raw
      .flatMap((part) => String(part || '').split('/'))
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function getQuerySuffix(req, excludedKeys = ['route']) {
  return buildHelperQuery(req && req.query ? req.query : {}, excludedKeys);
}

function sendNotFound(res) {
  res.status(404).json({ error: 'Not found' });
}

export default async function handler(req, res) {
  const segments = getRouteSegments(req);

  if (segments.length === 1 && segments[0] === 'info') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }
    await proxyCompositeHelperInfo(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'schema-check') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }
    await proxyHelperRequest(req, res, '/api/helper/schema-check');
    return;
  }

  if (segments.length === 1 && segments[0] === 'check') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await proxyDistributedCheck(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'convert') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await proxyDistributedHelperOperation(req, res, '/api/helper/convert');
    return;
  }

  if (segments.length === 1 && segments[0] === 'submit') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await proxyDistributedHelperOperation(req, res, '/api/helper/submit');
    return;
  }

  if (segments.length === 1 && segments[0] === 'jobs') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendMethodNotAllowed(res, ['GET', 'POST']);
      return;
    }
    const suffix = req.method === 'GET' ? getQuerySuffix(req) : '';
    await proxyHelperRequest(req, res, '/api/helper/jobs' + suffix);
    return;
  }

  if (segments.length === 2 && segments[0] === 'jobs') {
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      sendMethodNotAllowed(res, ['GET', 'DELETE']);
      return;
    }
    const suffix = req.method === 'GET' ? getQuerySuffix(req) : '';
    await proxyHelperRequest(req, res, '/api/helper/jobs/' + encodeURIComponent(segments[1]) + suffix);
    return;
  }

  if (segments.length === 3 && segments[0] === 'jobs' && segments[2] === 'result') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }
    const suffix = getQuerySuffix(req);
    await proxyHelperRequest(req, res, '/api/helper/jobs/' + encodeURIComponent(segments[1]) + '/result' + suffix);
    return;
  }

  sendNotFound(res);
}
