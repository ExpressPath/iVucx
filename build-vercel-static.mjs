import { cp, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(repoRoot, '.vercel-static');
const publicFiles = [
  'index.html',
  'Vucks.html',
  'editor.html',
  'post-preview.html',
  'post-runner.html',
  'CoqRunner.js',
  'LeanRunner.js',
  'theorem-draft-store.js',
  'googlee7047bac729c7d77.html'
];

if (path.dirname(outputDir) !== repoRoot || path.basename(outputDir) !== '.vercel-static') {
  throw new Error('Refusing to prepare a static directory outside the project root.');
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const relativePath of publicFiles) {
  const sourcePath = path.join(repoRoot, relativePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Public file is missing: ${relativePath}`);
  await copyFile(sourcePath, path.join(outputDir, relativePath));
}

await cp(path.join(repoRoot, 'assets'), path.join(outputDir, 'assets'), {
  recursive: true,
  force: false,
  errorOnExist: true
});

console.log(`Prepared ${publicFiles.length} public files and assets in ${outputDir}`);
