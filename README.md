# iVucx - Interactive Proof Assistant Editor

インタラクティブな証明支援システムエディタです。Coq、Lean、Isabelle、Agdaをサポートしています。

## 機能

- 証明支援システムのインタラクティブな編集
- グレーモードでのCoq証明検証（YY/NYのみ許可）
- リアルタイムの構文ハイライト
- サーバーサイド実行

## デプロイ

### Vercelへのデプロイ

1. Vercel CLIをインストール（未インストールの場合）：
   ```bash
   npm install -g vercel
   ```

2. プロジェクトをデプロイ：
   ```bash
   vercel
   ```

3. 初回デプロイ時は設定を尋ねられるので、以下のように回答：
   - Set up and deploy? → Y
   - Which scope? → 個人アカウントを選択
   - Link to existing project? → N
   - Project name → ivucx（または任意）
   - In which directory is your code located? → ./（Enter）

### ローカル開発

```bash
npm install
npm run dev
```

## プロジェクト構造

```
/
├── api/                    # Vercel API Routes
│   ├── check-login.js     # ログイン状態チェック
│   └── suggest.js         # サジェスチョン生成
├── editor.html            # エディタページ
├── index.html             # リダイレクトページ
├── Vucks.html             # メインアプリケーション
├── package.json           # プロジェクト設定
└── vercel.json            # Vercel設定
```

## API エンドポイント

- `GET /api/check-login` - ログイン状態を取得
- `POST /api/suggest` - サジェスチョン生成

## 証明検証（Coqのみ）

グレーモード（背景が灰色）でCoqを選択した場合：
- **YY**: `Qed.` で終了 → 証明完成・形式検証済み
- **NY**: `Admitted.` で終了 → 未証明・仮受け入れ
- **YN/NN**: エラーあり → 拒否（サーバー送信なし）

## ライセンス

MIT

## BlueMode Supabase Auth

Run the SQL below in Supabase SQL Editor before using BlueMode auth:

- `supabase/blue_mode_auth.sql`

Required Vercel environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

API routes used by BlueMode:

- `GET /api/check-login`
- `POST /api/blue-auth-signup`
- `POST /api/blue-auth-login`
- `POST /api/blue-auth-logout`

## Helper API

The current recommended topology is:

- `Supabase` stores durable state:
  - auth/session data
  - helper jobs
  - conversion plans
  - saved problems
- `Compute Engine` helper handles lightweight planning:
  - create / update conversion plans
  - read the right source bundle from Supabase
  - orchestrate GitHub Actions execution through the helper-compatible execution routes
  - persist final problem rows
- `GitHub Actions` handles heavy execution:
  - Lean / Coq proof checking
  - typed-lambda / `cic-v1` conversion
- `Vercel` (this `iVucx` app) remains the public entrypoint:
  - serves UI and auth routes
  - proxies execution requests to the execution API
  - proxies helper routes to the helper VM

Required environment variables on the main app:

- `HELPER_API_BASE_URL` - Compute Engine helper for conversion, submission, and jobs
- `HELPER_API_KEY` (optional)
- `HELPER_API_TIMEOUT_MS` (optional)
- `EXECUTION_API_BASE_URL` (optional when `HELPER_API_BASE_URL` points at a helper that exposes `/api/lean-check`, `/api/coq-check`, and `/api/proof-convert`)
- `EXECUTION_API_KEY` (optional; defaults to `HELPER_API_KEY` when the helper is reused as the execution endpoint)
- `EXECUTION_API_PRIVATE_KEY` or `EXECUTION_API_PRIVATE_KEY_PATH` (optional PEM request signing)
- `EXECUTION_API_TIMEOUT_MS`
- `ALLOW_LOCAL_EXECUTION_FALLBACK` (optional, defaults to `false` in production)
- `ALLOW_LOCAL_HELPER_FALLBACK` (optional, defaults to `false` in production)

Accepted aliases for the execution server:

- `ORACLE_SERVER_BASE_URL`
- `ORACLE_SERVER_API_KEY`
- `ORACLE_SERVER_PRIVATE_KEY`
- `ORACLE_SERVER_PRIVATE_KEY_PATH`
- `ORACLE_SERVER_TIMEOUT_MS`

Split behavior:

- `POST /api/lean-check` -> Vercel proxies proof check to the configured execution API; if `EXECUTION_API_BASE_URL` is unset, it can reuse `HELPER_API_BASE_URL`
- `POST /api/coq-check` -> same as above for Coq
- `POST /api/proof-convert` -> Vercel proxies typed-lambda / `cic-v1` conversion to the configured execution API
- `POST /api/helper/check` -> helper-routed proof check via the same execution backend
- `POST /api/helper/convert` -> the helper creates a Supabase-backed conversion plan, then GitHub Actions executes it
- `POST /api/helper/submit` -> the helper creates a Supabase-backed submission plan, then GitHub Actions executes it and the helper saves the problem row
- `GET /api/helper/info` -> helper info plus deployment metadata
- `GET /api/helper/schema-check` -> helper-side Supabase schema diagnosis

The helper / executor side also needs:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Lean / Coq toolchain setup in GitHub Actions
- `HELPER_API_KEY` as a GitHub Actions secret when callbacks are protected

Recommended deployment note:

- The simplest Vercel setup is:
  - `HELPER_API_BASE_URL=http://<gce-helper-ip-or-domain>`
  - `EXECUTION_API_BASE_URL` unset
- In that setup, direct proof routes on Vercel reuse the helper's Render-compatible execution routes, and the helper forwards heavy work to GitHub Actions.

Google Compute Engine helper files:

- `../nodejs/deploy/gce/compose.yaml`
- `../nodejs/deploy/gce/runtime.env.example`
- `../nodejs/deploy/gce/startup-script.sh`
- `../nodejs/deploy/gce/create-instance.sh`
- `../nodejs/deploy/gce/create-firewall-rule.sh`
- `../nodejs/deploy/gce/README.md`

Proxy routes:

- `GET /api/helper/info`
- `POST /api/helper/check`
- `POST /api/helper/submit`
- `POST /api/helper/convert`
- `GET /api/helper/jobs`
- `GET /api/helper/jobs/:id`
- `GET /api/helper/jobs/:id/result`
- `DELETE /api/helper/jobs/:id`

Helper service files:

- `services/railway-helper/package.json`
- `services/railway-helper/Dockerfile`
- `services/railway-helper/index.js`
- `services/railway-helper/README.md`
- `services/railway-helper/.env.example`
- `services/railway-helper/ADAPTER_PROTOCOL.md`
- `services/railway-helper/EXACT_EXPORT_SOURCES.md`
- `supabase/proof_helper.sql`
- `supabase/proof_helper_check.sql`

If the helper is missing `helper_conversion_plans`, it can now fall back to in-memory planning for the current process, but durable planning still requires the Supabase schema above.
