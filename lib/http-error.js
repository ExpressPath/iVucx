function normalizedStatus(value, fallback) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function getHttpErrorStatus(error, fallback = 500) {
  const safeFallback = normalizedStatus(fallback, 500);
  return normalizedStatus(error && (error.statusCode || error.status), safeFallback);
}

export function getPublicErrorMessage(error, fallback, status = getHttpErrorStatus(error)) {
  if (process.env.NODE_ENV === 'production' && status >= 500) {
    return fallback;
  }
  const message = error && typeof error.message === 'string'
    ? error.message.trim()
    : '';
  return message || fallback;
}

export function getPublicErrorDetails(details, status) {
  return process.env.NODE_ENV === 'production' && status >= 500
    ? null
    : (details || null);
}
