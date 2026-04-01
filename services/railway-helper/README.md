# Railway Helper Service

Railway に載せる proof helper API です。

## Purpose

- Coq / Lean の検証
- 非同期ジョブ受付
- 再起動時の stale job 失敗化
- 正規化アダプタ実行
- Supabase の `public.problems` 保存

## Routes

- `GET /healthz`
- `GET /api/helper/info`
- `POST /api/helper/check`
- `POST /api/helper/submit`
- `POST /api/helper/convert`
- `GET /api/helper/jobs`
- `GET /api/helper/jobs/:id`
- `GET /api/helper/jobs/:id/result`
- `DELETE /api/helper/jobs/:id`

## Required Env

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Proof Toolchain Env

- `LEAN_CMD`
- `LEAN_ARGS`
- `LEAN_WORKDIR`
- `COQ_CMD`
- `COQ_ARGS`
- `COQ_WORKDIR`

## Exact Adapter Env

The helper server is intentionally built to call exact exporter adapters rather than faking a lossy translation.

- `HELPER_LEAN_ADAPTER_CMD`
- `HELPER_LEAN_ADAPTER_ARGS`
- `HELPER_COQ_ADAPTER_CMD`
- `HELPER_COQ_ADAPTER_ARGS`

Adapter contract:

- Request JSON is passed on `stdin`
- Adapter must print JSON on `stdout`
- Successful output must include either:
  - `term`
  - or `result.term`
- Optional `proofState` can override the helper's coarse fallback classification when the adapter knows the exact status.

Suggested upstream directions:

- Lean: elaborated `Expr` / export based adapter
- Rocq / Coq: MetaRocq / Template-Rocq quotation based adapter

Related local files:

- `.env.example`
- `ADAPTER_PROTOCOL.md`
- `EXACT_EXPORT_SOURCES.md`

## Railway Notes

- Deploy this directory with its Dockerfile
- Public service only if you want to call it directly
- Usually this should be a private helper service and the main app should proxy to it
