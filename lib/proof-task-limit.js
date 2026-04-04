const MAX_CONCURRENT_PROOF_TASKS = Math.max(
  1,
  Number(process.env.IVUCX_MAX_CONCURRENT_PROOF_TASKS || 1)
);

let activeTasks = 0;
const pendingTasks = [];

function drainQueue() {
  while (activeTasks < MAX_CONCURRENT_PROOF_TASKS && pendingTasks.length > 0) {
    const next = pendingTasks.shift();
    if (!next) {
      return;
    }

    activeTasks += 1;
    Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        activeTasks = Math.max(0, activeTasks - 1);
        drainQueue();
      });
  }
}

export function runProofTaskWithLimit(run, meta = {}) {
  if (typeof run !== 'function') {
    return Promise.reject(new TypeError('runProofTaskWithLimit requires a function'));
  }

  return new Promise((resolve, reject) => {
    pendingTasks.push({
      resolve,
      reject,
      run,
      meta: {
        kind: meta.kind || 'proof-task',
        queuedAt: Date.now()
      }
    });
    drainQueue();
  });
}

export function getProofTaskQueueSnapshot() {
  return {
    active: activeTasks,
    queued: pendingTasks.length,
    concurrency: MAX_CONCURRENT_PROOF_TASKS
  };
}
