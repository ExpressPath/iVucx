function responseLimitError(limit) {
  const error = new Error(`Upstream response exceeded the ${limit}-byte safety limit.`);
  error.statusCode = 502;
  error.code = 'UPSTREAM_RESPONSE_TOO_LARGE';
  return error;
}

export async function readBoundedResponseBuffer(response, maxBytes) {
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || 1024));
  const declaredLength = Number(response && response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw responseLimitError(limit);
  }

  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw responseLimitError(limit);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw responseLimitError(limit);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readBoundedResponseText(response, maxBytes) {
  return (await readBoundedResponseBuffer(response, maxBytes)).toString('utf8');
}
