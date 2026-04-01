# Exact Export Sources

These are the primary sources currently informing the helper-server design.

## Lean

- Lean 4 declaration export project:
  - https://github.com/leanprover/lean4export
- Lean 4 NDJSON export format:
  - https://raw.githubusercontent.com/leanprover/lean4export/master/format_ndjson.md

Current takeaway:

- Lean already has an export path built around elaborated declarations and `Expr`-level data.
- This is a much better base for exact normalization than parsing surface syntax.

## Rocq / Coq

- MetaRocq repository:
  - https://github.com/MetaRocq/metarocq
- Template-Rocq overview:
  - https://github.com/MetaRocq/metarocq
- Rocq LSP:
  - https://github.com/rocq-community/rocq-lsp
- SerAPI status note:
  - https://github.com/ejgallego/coq-serapi

Current takeaway:

- Template-Rocq quotes Rocq terms using a syntax tree based on the kernel term representation.
- `rocq-lsp` exposes machine-oriented tooling and an extensible command-line compiler.
- SerAPI is useful historical context, but it is no longer the preferred forward path.

## Design Direction

- Do not claim an exact Lean/Coq-to-common-term conversion from raw surface syntax alone.
- Prefer language-specific exporters that emit elaborated / kernel-level structures.
- Normalize those exported structures into the helper server's shared JSON term format.
