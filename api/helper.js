import {
  buildHelperQuery,
  proxyCompositeHelperInfo,
  proxyDistributedCheck,
  proxyDistributedHelperOperation,
  proxyHelperRequest,
  sendMethodNotAllowed
} from '../lib/helper-proxy.js';
import { sendBountyCheckoutResponse } from '../lib/bounty-checkout.js';
import { sendConditionalCheckoutResponse } from '../lib/conditional-checkout.js';
import { sendStripeSetupResponse } from '../lib/stripe-setup.js';
import { sendAttachmentCompleteResponse, sendAttachmentUploadPlanResponse } from '../lib/problem-attachments.js';
import { sendPersistedProblemResponse, sendProblemPersistenceStatusResponse } from '../lib/problem-store.js';
import { sendProofAiResponse } from '../lib/proof-ai.js';
import { sendProblemConditionalRegisterResponse, sendProblemSolutionResolveResponse } from '../lib/ivucx.js';
import { verifyJobCapability } from '../lib/job-access.js';

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

function readJobToken(req) {
  const header = req && req.headers ? req.headers['x-ivucx-job-token'] : '';
  const query = req && req.query ? req.query.jobToken : '';
  return String((Array.isArray(header) ? header[0] : header) || (Array.isArray(query) ? query[0] : query) || '').trim();
}

function assertJobAccess(req, res, jobId) {
  if (verifyJobCapability(jobId, readJobToken(req))) return true;
  res.status(403).json({ ok: false, error: 'Helper job access is not authorized.' });
  return false;
}

export default async function handler(req, res) {
  const segments = getRouteSegments(req);

  if (segments.length === 1 && segments[0] === 'bounty-checkout') {
    await sendBountyCheckoutResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'conditional-checkout') {
    await sendConditionalCheckoutResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'stripe-setup') {
    await sendStripeSetupResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'proof-ai') {
    await sendProofAiResponse(req, res);
    return;
  }

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
    if (process.env.NODE_ENV === 'production') {
      sendNotFound(res);
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

  if (segments.length === 1 && segments[0] === 'persist') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await sendPersistedProblemResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'persist-check') {
    if (process.env.NODE_ENV === 'production') {
      sendNotFound(res);
      return;
    }
    await sendProblemPersistenceStatusResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'resolve-problem') {
    await sendProblemSolutionResolveResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'register-conditional') {
    await sendProblemConditionalRegisterResponse(req, res);
    return;
  }

  if (segments.length === 2 && segments[0] === 'attachments' && segments[1] === 'sign') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await sendAttachmentUploadPlanResponse(req, res);
    return;
  }

  if (segments.length === 2 && segments[0] === 'attachments' && segments[1] === 'complete') {
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await sendAttachmentCompleteResponse(req, res);
    return;
  }

  if (segments.length === 1 && segments[0] === 'jobs') {
    if (req.method === 'GET') {
      sendNotFound(res);
      return;
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res, ['POST']);
      return;
    }
    await proxyHelperRequest(req, res, '/api/helper/jobs');
    return;
  }

  if (segments.length === 2 && segments[0] === 'jobs') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }
    if (!assertJobAccess(req, res, segments[1])) return;
    const suffix = getQuerySuffix(req, ['route', 'jobToken']);
    await proxyHelperRequest(req, res, '/api/helper/jobs/' + encodeURIComponent(segments[1]) + suffix);
    return;
  }

  if (segments.length === 3 && segments[0] === 'jobs' && segments[2] === 'result') {
    if (req.method !== 'GET') {
      sendMethodNotAllowed(res, ['GET']);
      return;
    }
    if (!assertJobAccess(req, res, segments[1])) return;
    const suffix = getQuerySuffix(req, ['route', 'jobToken']);
    await proxyHelperRequest(req, res, '/api/helper/jobs/' + encodeURIComponent(segments[1]) + '/result' + suffix);
    return;
  }

  sendNotFound(res);
}
