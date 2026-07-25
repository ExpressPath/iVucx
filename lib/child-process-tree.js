import { spawn } from 'node:child_process';

export function isolatedProcessOptions() {
  return process.platform === 'win32'
    ? { windowsHide: true }
    : { detached: true };
}

export function terminateProcessTree(child, signal = 'SIGKILL') {
  const pid = Number(child && child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => {});
      killer.unref();
      return;
    } catch (error) {
      try { child.kill(); } catch (killError) {}
      return;
    }
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    try { child.kill(signal); } catch (killError) {}
  }
}
