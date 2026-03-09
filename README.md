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
