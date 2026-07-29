import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') return fallbackValue;
  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

function addDirectoryChain(args, targetPath, seen) {
  const normalized = path.posix.normalize(targetPath);
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    if (!seen.has(current)) {
      args.push('--dir', current);
      seen.add(current);
    }
  }
}

function isWithinDirectory(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function positiveInteger(value, fallbackValue, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallbackValue;
}

export function prepareProofProcessCommand(command, commandArgs = [], options = {}) {
  const platform = options.platform || process.platform;
  const production = options.production === undefined
    ? String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    : Boolean(options.production);
  const sandboxRequired = options.sandboxRequired === undefined
    ? parseBoolean(process.env.IVUCX_PROOF_SANDBOX_REQUIRED, production)
    : Boolean(options.sandboxRequired);

  if (!sandboxRequired) {
    return {
      command,
      args: [...commandArgs],
      sandboxed: false
    };
  }
  if (platform !== 'linux') {
    const error = new Error('Proof OS sandboxing is required but is supported only on Linux.');
    error.code = 'PROOF_SANDBOX_UNAVAILABLE';
    throw error;
  }

  const cwd = String(options.cwd || '').trim();
  if (!cwd || !path.posix.isAbsolute(cwd)) {
    const error = new Error('Proof sandbox requires an absolute working directory.');
    error.code = 'PROOF_SANDBOX_INVALID_WORKDIR';
    throw error;
  }
  const tempRoot = String(options.tempRoot || os.tmpdir()).trim();
  if (!isWithinDirectory(path.resolve(cwd), path.resolve(tempRoot))) {
    const error = new Error('Proof sandbox working directory must be inside the operating-system temporary directory.');
    error.code = 'PROOF_SANDBOX_INVALID_WORKDIR';
    throw error;
  }

  const sandboxCommand = String(
    options.sandboxCommand
    || process.env.IVUCX_PROOF_SANDBOX_CMD
    || '/usr/bin/bwrap'
  ).trim();
  const pathExists = options.pathExists || existsSync;
  if (path.posix.isAbsolute(sandboxCommand) && !pathExists(sandboxCommand)) {
    const error = new Error(`Required proof sandbox executable was not found: ${sandboxCommand}`);
    error.code = 'PROOF_SANDBOX_UNAVAILABLE';
    throw error;
  }
  const limitCommand = String(
    options.limitCommand
    || process.env.IVUCX_PROOF_LIMIT_CMD
    || '/usr/bin/prlimit'
  ).trim();
  if (path.posix.isAbsolute(limitCommand) && !pathExists(limitCommand)) {
    const error = new Error(`Required proof resource-limit executable was not found: ${limitCommand}`);
    error.code = 'PROOF_SANDBOX_UNAVAILABLE';
    throw error;
  }

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--cap-drop', 'ALL',
    '--hostname', 'ivucx-proof'
  ];
  const createdDirectories = new Set();
  const runtimeRoots = options.runtimeRoots || [
    '/usr',
    '/lib',
    '/lib64',
    '/etc',
    '/opt/elan',
    '/home/opam/.opam/ivucx',
    '/app/server-tools',
    '/app/node_modules'
  ];

  for (const runtimeRoot of runtimeRoots) {
    if (!pathExists(runtimeRoot)) continue;
    addDirectoryChain(args, runtimeRoot, createdDirectories);
    args.push('--ro-bind', runtimeRoot, runtimeRoot);
  }

  addDirectoryChain(args, '/proc', createdDirectories);
  args.push('--proc', '/proc');
  addDirectoryChain(args, '/dev', createdDirectories);
  args.push('--dev', '/dev');
  addDirectoryChain(args, '/tmp', createdDirectories);
  args.push('--tmpfs', '/tmp');
  addDirectoryChain(args, cwd, createdDirectories);
  args.push(
    '--bind', cwd, cwd,
    '--chdir', cwd,
    '--setenv', 'HOME', cwd,
    '--setenv', 'TMPDIR', cwd,
    '--setenv', 'TMP', cwd,
    '--setenv', 'TEMP', cwd,
    '--',
    command,
    ...commandArgs
  );

  const maxProcesses = positiveInteger(
    options.maxProcesses || process.env.IVUCX_PROOF_MAX_PROCESSES,
    64,
    8
  );
  const maxAddressSpaceBytes = positiveInteger(
    options.maxAddressSpaceBytes || process.env.IVUCX_PROOF_MAX_ADDRESS_SPACE_BYTES,
    2 * 1024 * 1024 * 1024,
    256 * 1024 * 1024
  );
  const maxFileBytes = positiveInteger(
    options.maxFileBytes || process.env.IVUCX_PROOF_MAX_FILE_BYTES,
    32 * 1024 * 1024,
    1024 * 1024
  );
  const maxOpenFiles = positiveInteger(
    options.maxOpenFiles || process.env.IVUCX_PROOF_MAX_OPEN_FILES,
    256,
    32
  );
  const maxCpuSeconds = positiveInteger(
    options.maxCpuSeconds || process.env.IVUCX_PROOF_MAX_CPU_SECONDS,
    180,
    10
  );

  return {
    command: limitCommand,
    args: [
      `--nproc=${maxProcesses}`,
      `--as=${maxAddressSpaceBytes}`,
      `--fsize=${maxFileBytes}`,
      `--nofile=${maxOpenFiles}`,
      `--cpu=${maxCpuSeconds}`,
      '--',
      sandboxCommand,
      ...args
    ],
    sandboxed: true
  };
}

export function isolatedProcessOptions() {
  return process.platform === 'win32'
    ? { windowsHide: true }
    : { detached: true };
}

export async function assertProofSandboxRuntimeAvailable(options = {}) {
  const production = options.production === undefined
    ? String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    : Boolean(options.production);
  const sandboxRequired = options.sandboxRequired === undefined
    ? parseBoolean(process.env.IVUCX_PROOF_SANDBOX_REQUIRED, production)
    : Boolean(options.sandboxRequired);
  if (!sandboxRequired) return { available: true, required: false };

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ivucx-sandbox-smoke-'));
  try {
    const prepared = prepareProofProcessCommand('/usr/bin/true', [], {
      ...options,
      cwd: tempDir,
      production,
      sandboxRequired: true
    });
    const result = await new Promise((resolve) => {
      const child = spawn(prepared.command, prepared.args, {
        cwd: tempDir,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        ...isolatedProcessOptions()
      });
      let stderr = '';
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      const timer = setTimeout(() => {
        terminateProcessTree(child);
        finish({ error: new Error('Proof sandbox self-test timed out.'), stderr });
      }, positiveInteger(options.timeoutMs, 10000, 1000));
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) stderr += String(chunk || '').slice(0, 4096 - stderr.length);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ error, stderr });
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        finish({ exitCode, signal, stderr });
      });
    });

    if (result.error || result.exitCode !== 0) {
      const detail = String(result.stderr || result.error?.message || result.signal || 'unknown failure').trim();
      const error = new Error(`Required proof sandbox self-test failed: ${detail}`);
      error.code = 'PROOF_SANDBOX_UNAVAILABLE';
      throw error;
    }
    return { available: true, required: true };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
