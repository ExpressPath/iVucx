const MAX_CONCURRENT_PROOF_TASKS = Math.max(
  1,
  Number(process.env.IVUCX_MAX_CONCURRENT_PROOF_TASKS || 1)
);
const MAX_PENDING_PROOF_TASKS = Math.max(
  0,
  Number(process.env.IVUCX_MAX_PENDING_PROOF_TASKS || 12)
);
const MAX_PROOF_QUEUE_WAIT_MS = Math.max(
  1000,
  Number(process.env.IVUCX_MAX_PROOF_QUEUE_WAIT_MS || 60000)
);

let activeTasks = 0;
const pendingTasks = [];

function createQueueError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function removePendingTask(task) {
  const index = pendingTasks.indexOf(task);
  if (index >= 0) {
    pendingTasks.splice(index, 1);
    return true;
  }
  return false;
}

function drainQueue() {
  while (activeTasks < MAX_CONCURRENT_PROOF_TASKS && pendingTasks.length > 0) {
    const next = pendingTasks.shift();
    if (!next) {
      return;
    }

    next.started = true;
    if (next.timer) {
      clearTimeout(next.timer);
      next.timer = null;
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
    if (pendingTasks.length >= MAX_PENDING_PROOF_TASKS) {
      reject(createQueueError(429, 'Proof verification queue is full. Retry later.', {
        queued: pendingTasks.length,
        active: activeTasks,
        concurrency: MAX_CONCURRENT_PROOF_TASKS
      }));
      return;
    }

    const task = {
      resolve,
      reject,
      run,
      meta: {
        kind: meta.kind || 'proof-task',
        queuedAt: Date.now()
      },
      started: false,
      timer: null
    };
    task.timer = setTimeout(() => {
      if (task.started) return;
      if (removePendingTask(task)) {
        reject(createQueueError(503, 'Proof verification queue wait timed out.', {
          kind: task.meta.kind,
          queuedAt: task.meta.queuedAt,
          maxQueueWaitMs: MAX_PROOF_QUEUE_WAIT_MS
        }));
      }
    }, MAX_PROOF_QUEUE_WAIT_MS);
    pendingTasks.push(task);
    drainQueue();
  });
}

export function getProofTaskQueueSnapshot() {
  return {
    active: activeTasks,
    queued: pendingTasks.length,
    concurrency: MAX_CONCURRENT_PROOF_TASKS,
    maxQueued: MAX_PENDING_PROOF_TASKS,
    maxQueueWaitMs: MAX_PROOF_QUEUE_WAIT_MS
  };
}
