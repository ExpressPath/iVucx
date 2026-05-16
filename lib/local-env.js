import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ENV_FILES = ['.env', '.env.local'];

function stripInlineComment(value) {
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && value[i - 1] !== '\\') {
      quote = quote === char ? '' : (quote || char);
      continue;
    }
    if (char === '#' && !quote) {
      const previous = value[i - 1] || '';
      if (!previous || /\s/.test(previous)) {
        return value.slice(0, i).trimEnd();
      }
    }
  }
  return value;
}

function parseEnvValue(raw) {
  let value = stripInlineComment(String(raw || '').trim());
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      if (first === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
      }
    }
  }
  return value;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) return;
    process.env[key] = parseEnvValue(match[2]);
  });
}

ENV_FILES.forEach((fileName) => {
  loadEnvFile(path.resolve(process.cwd(), fileName));
});
