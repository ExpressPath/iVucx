#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivucx-cic-smoke-'));

function runConverter(name, converter, sourceName, source, expectedEncoding) {
  const sourcePath = path.join(tempDir, sourceName);
  const outputPath = path.join(tempDir, `${name}.json`);
  fs.writeFileSync(sourcePath, `${source.trim()}\n`, 'utf8');

  const result = spawnSync(process.execPath, [
    path.join(rootDir, 'server-tools', converter),
    '--out',
    outputPath,
    sourcePath
  ], {
    cwd: tempDir,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 240000
  });

  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${name} CIC converter failed:\n${result.stderr || result.stdout || '(no output)'}`
  );

  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(payload.format, 'cic-v1');
  assert.ok(payload.term && typeof payload.term === 'object', `${name} proof term is missing`);
  assert.ok(
    payload.context && payload.context.type && typeof payload.context.type === 'object',
    `${name} theorem type is missing`
  );
  assert.equal(payload.metadata?.normalization?.sourceEncoding, expectedEncoding);
  assert.equal(payload.metadata?.normalization?.rawTermNodes, 0);
  assert.equal(payload.metadata?.normalization?.rawLevelNodes, 0);
  assert.equal(payload.metadata?.normalization?.rawTextNodes, 0);
}

try {
  runConverter(
    'lean',
    'convert-lean-cic.cjs',
    'Main.lean',
    'theorem complete : True := by trivial',
    'lean4export-ndjson'
  );
  runConverter(
    'coq',
    'convert-coq-cic.cjs',
    'Main.v',
    'Theorem complete : True. Proof. exact I. Qed.',
    'metarocq-template'
  );
  process.stdout.write('Lean and Coq CIC smoke tests passed.\n');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
