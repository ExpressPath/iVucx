# Railway Helper Service

Railway に載せる軽量 helper API です。

## Role Split

- `Supabase`
  - user/session などの状態
  - helper job
  - conversion plan
  - saved problem
- `Railway helper`
  - 計算計画の作成
  - Supabase への plan / job 保存
  - `planId` ベースで Render 実行をオーケストレーション
  - 完了後の `problems` 保存
- `Render` (`iVucx` 本体)
  - Lean / Coq proof check
  - typed-lambda / `cic-v1` の重い変換
  - Supabase から `helper_conversion_plans` を読んで必要な source だけ取得

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
- `EXECUTION_SERVER_BASE_URL`

Optional:

- `HELPER_API_KEY`
- `EXECUTION_SERVER_API_KEY`
- `EXECUTION_SERVER_TIMEOUT_MS`
- `EXECUTION_SERVER_CONVERT_ROUTE`
- `EXECUTION_SERVER_LEAN_CHECK_ROUTE`
- `EXECUTION_SERVER_COQ_CHECK_ROUTE`
- `HELPER_MAX_CODE_BYTES`

## Supabase Schema

Run:

- `supabase/proof_helper.sql`

This now creates:

- `public.problems`
- `public.helper_jobs`
- `public.helper_conversion_plans`

## Notes

- Railway helper no longer builds Lean / Coq toolchains.
- Heavy CIC conversion is intentionally left to Render.
- Jobs keep progress metadata so the UI can show short real-time status text.
