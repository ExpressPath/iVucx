const ALLOWED_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'
]);

const ALLOWED_PREFIXES = [
  'COQ', 'LEAN', 'OPAM', 'OCAML', 'CAML', 'PYTHON', 'XDG_', 'NIX_'
];

function isAllowedKey(key) {
  return ALLOWED_KEYS.has(key) || ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function buildProofProcessEnv(extra = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (isAllowedKey(key) && typeof value === 'string') environment[key] = value;
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (isAllowedKey(key) && typeof value === 'string') environment[key] = value;
  }
  environment.IVUCX_PROOF_SANDBOX = 'restricted-env-v1';
  return environment;
}
