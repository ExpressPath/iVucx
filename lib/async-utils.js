export async function mapWithConcurrency(items, limit, mapper) {
  const rows = Array.from(items || []);
  if (!rows.length) return [];
  if (typeof mapper !== 'function') {
    throw new TypeError('mapper must be a function.');
  }

  const workerCount = Math.min(
    rows.length,
    Math.max(1, Math.floor(Number(limit) || 1))
  );
  const results = new Array(rows.length);
  let nextIndex = 0;
  let firstError = null;

  async function work() {
    while (!firstError && nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(rows[index], index);
      } catch (error) {
        firstError = firstError || error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => work()));
  if (firstError) throw firstError;
  return results;
}

export function createAsyncLimiter(limit) {
  const maxActive = Math.max(1, Math.floor(Number(limit) || 1));
  const queue = [];
  let active = 0;

  function drain() {
    while (active < maxActive && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return function limitTask(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('task must be a function.'));
    }
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  };
}
