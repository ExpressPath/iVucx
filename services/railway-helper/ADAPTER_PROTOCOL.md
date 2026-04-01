# Adapter Protocol

The Railway helper intentionally delegates exact normalization to language-specific adapters.

## Why

- Lean and Coq should not be normalized from surface syntax with a lossy parser.
- The helper expects an adapter to work from elaborated / kernel-level data and return a shared typed-lambda-style JSON term.

## Request

The helper writes one JSON object to `stdin`.

```json
{
  "schema": "ivucx-helper-adapter-request-v1",
  "title": "Example theorem",
  "language": "Lean",
  "fileName": "Main.lean",
  "code": "theorem t : True := by trivial",
  "requestedFormat": "typed-lambda-v1",
  "verification": {
    "proofState": "YY",
    "status": "verified"
  }
}
```

## Response

The adapter must print one JSON object to `stdout`.

Required fields:

- `term`

Optional fields:

- `adapter`
- `format`
- `meta`
- `proofState`

Example:

```json
{
  "adapter": "lean4export-adapter",
  "format": "typed-lambda-v1",
  "proofState": "YY",
  "term": {
    "kind": "const",
    "name": "True.intro"
  },
  "meta": {
    "source": "elaborated-expr"
  }
}
```

## Expected Upstream Sources

- Lean: elaborated `Expr` / export pipeline such as `lean4export`
- Rocq / Coq: kernel-term quotation via MetaRocq / Template-Rocq, or another kernel-level exporter
