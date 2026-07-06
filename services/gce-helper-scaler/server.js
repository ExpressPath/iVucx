import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const PROJECT_ID = String(process.env.PROJECT_ID || '').trim();
const ZONE = String(process.env.ZONE || '').trim();
const WORKER_NAMES = parseList(process.env.WORKER_NAMES);
const API_KEY = String(process.env.SCALER_API_KEY || '').trim();
const IDLE_STOP_AFTER_MS = Number(process.env.IDLE_STOP_AFTER_MS || 20 * 60 * 1000);
const LAST_ACTIVITY_KEY = 'ivucx-last-activity-ms';
const REASON_KEY = 'ivucx-last-scale-reason';

function parseList(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function authorize(req) {
  if (!API_KEY) {
    return false;
  }
  return req.headers.authorization === `Bearer ${API_KEY}`;
}

async function getAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!response.ok) {
    throw new Error(`metadata token request failed: ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('metadata token missing access_token');
  }
  return payload.access_token;
}

async function computeFetch(path, options = {}) {
  if (!PROJECT_ID || !ZONE || !WORKER_NAMES.length) {
    const error = new Error('PROJECT_ID, ZONE, and WORKER_NAMES must be configured');
    error.statusCode = 500;
    throw error;
  }

  const token = await getAccessToken();
  const response = await fetch(
    `https://compute.googleapis.com/compute/v1/projects/${PROJECT_ID}/zones/${ZONE}${path}`,
    {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    }
  );
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { text };
  }
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `Compute API request failed: ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function waitForZoneOperation(operation, timeoutMs = 30000) {
  if (!operation || !operation.name) {
    return operation;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await computeFetch(`/operations/${encodeURIComponent(operation.name)}`);
    if (current.status === 'DONE') {
      if (current.error && Array.isArray(current.error.errors) && current.error.errors.length) {
        throw new Error(current.error.errors.map((entry) => entry.message || entry.code).join('; '));
      }
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return operation;
}

async function getInstance(name) {
  return computeFetch(`/instances/${encodeURIComponent(name)}`);
}

async function startInstance(name) {
  return computeFetch(`/instances/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

async function stopInstance(name) {
  return computeFetch(`/instances/${encodeURIComponent(name)}/stop`, { method: 'POST' });
}

function metadataItems(instance) {
  return instance && instance.metadata && Array.isArray(instance.metadata.items)
    ? instance.metadata.items
    : [];
}

function metadataValue(instance, key) {
  const item = metadataItems(instance).find((entry) => entry && entry.key === key);
  return item ? String(item.value || '') : '';
}

async function setInstanceMetadata(instance, updates) {
  const existingItems = metadataItems(instance)
    .filter((item) => item && item.key && !Object.prototype.hasOwnProperty.call(updates, item.key));
  const items = [
    ...existingItems,
    ...Object.entries(updates).map(([key, value]) => ({ key, value: String(value) }))
  ];
  return computeFetch(`/instances/${encodeURIComponent(instance.name)}/setMetadata`, {
    method: 'POST',
    body: JSON.stringify({
      fingerprint: instance.metadata ? instance.metadata.fingerprint : '',
      items
    })
  });
}

function summarizeInstance(instance) {
  return {
    name: instance.name,
    status: instance.status,
    machineType: String(instance.machineType || '').split('/').pop() || null,
    externalIp: instance.networkInterfaces
      && instance.networkInterfaces[0]
      && instance.networkInterfaces[0].accessConfigs
      && instance.networkInterfaces[0].accessConfigs[0]
      ? instance.networkInterfaces[0].accessConfigs[0].natIP || null
      : null,
    lastActivityMs: Number(metadataValue(instance, LAST_ACTIVITY_KEY) || 0),
    lastScaleReason: metadataValue(instance, REASON_KEY) || null
  };
}

async function getWorkers() {
  const instances = await Promise.all(WORKER_NAMES.map((name) => getInstance(name)));
  return instances;
}

async function touchWorkers(reason) {
  const now = String(Date.now());
  const instances = await getWorkers();
  const operations = await Promise.all(instances.map(async (instance) => {
    const operation = await setInstanceMetadata(instance, {
      [LAST_ACTIVITY_KEY]: now,
      [REASON_KEY]: reason || 'activity'
    });
    return waitForZoneOperation(operation);
  }));
  const updatedInstances = await getWorkers();
  return {
    touchedAtMs: Number(now),
    operations,
    workers: updatedInstances.map(summarizeInstance)
  };
}

async function scaleOut(reason) {
  const touch = await touchWorkers(reason || 'scale-out');
  const instances = await getWorkers();
  const operations = [];

  for (const instance of instances) {
    if (instance.status === 'TERMINATED') {
      operations.push(await startInstance(instance.name));
    }
  }

  return {
    action: 'scale-out',
    started: operations.length,
    workers: instances.map(summarizeInstance),
    operations,
    touchedAtMs: touch.touchedAtMs
  };
}

async function reconcile() {
  const instances = await getWorkers();
  const now = Date.now();
  const lastActivityMs = Math.max(
    0,
    ...instances.map((instance) => Number(metadataValue(instance, LAST_ACTIVITY_KEY) || 0))
  );
  const idleMs = lastActivityMs ? now - lastActivityMs : Number.POSITIVE_INFINITY;
  const operations = [];

  if (idleMs >= IDLE_STOP_AFTER_MS) {
    for (const instance of instances) {
      if (instance.status === 'RUNNING') {
        operations.push(await stopInstance(instance.name));
      }
    }
  }

  return {
    action: 'reconcile',
    idleMs: Number.isFinite(idleMs) ? idleMs : null,
    idleStopAfterMs: IDLE_STOP_AFTER_MS,
    stopped: operations.length,
    workers: instances.map(summarizeInstance),
    operations
  };
}

async function handle(req, res) {
  if (req.url === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'ivucx-gce-helper-scaler' });
    return;
  }

  if (!authorize(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');

  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      const workers = await getWorkers();
      sendJson(res, 200, { ok: true, workers: workers.map(summarizeInstance) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/touch') {
      const body = await readBody(req);
      const result = await touchWorkers(body.reason || 'activity');
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/scale-out') {
      const body = await readBody(req);
      const result = await scaleOut(body.reason || 'scale-out');
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reconcile') {
      const result = await reconcile();
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      ok: false,
      error: error.message || String(error)
    });
  }
}

http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  });
}).listen(PORT, () => {
  console.log(`ivucx-gce-helper-scaler listening on ${PORT}`);
});
