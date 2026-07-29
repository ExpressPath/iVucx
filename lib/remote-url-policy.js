import { isIP } from 'node:net';

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return false;
}

export function isPrivateNetworkHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (isLoopbackHost(host)) return true;
  if (host === 'metadata.google.internal' || host === 'metadata.google.internal.') return true;
  if (host.endsWith('.internal') || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const family = isIP(host);
  if (family === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (family === 6) {
    return host === '::'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || host.startsWith('fe8')
      || host.startsWith('fe9')
      || host.startsWith('fea')
      || host.startsWith('feb');
  }
  return false;
}

export function normalizeRemoteServiceBaseUrl(value, options = {}) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';

  const production = options.production === undefined
    ? String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    : Boolean(options.production);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error('Remote service URL must be an absolute HTTPS URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Remote service URL must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Remote service URL must not contain credentials, query parameters, or fragments.');
  }
  if (parsed.protocol !== 'https:' && (production || !isLoopbackHost(parsed.hostname))) {
    throw new Error('Remote service URL must use HTTPS; plain HTTP is allowed only for loopback development.');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function tryNormalizeRemoteServiceBaseUrl(value, options = {}) {
  try {
    return normalizeRemoteServiceBaseUrl(value, options);
  } catch (_error) {
    return '';
  }
}
