# iVucxプロモーション環境

公式APIだけを使い、X・TikTok・Instagramへ投稿するためのローカル環境です。
初期状態はドライランで、`PROMOTION_CONFIRM_PUBLISH=YES`と`publish`コマンドの
両方がそろわない限り、外部投稿は発生しません。

## 最初の準備

1. `promotion/.env.example`を`promotion/.env`へコピーする。
2. 下記の認証情報を`promotion/.env`へ入力する。
3. `promotion/campaign.example.json`をコピーして、本番URL・文章・メディアURLを変更する。
4. 接続確認とドライランを実行する。

```powershell
Copy-Item promotion\.env.example promotion\.env
node promotion\promote.mjs check --platform all
node promotion\promote.mjs dry-run --campaign promotion\campaign.example.json
```

実投稿は、対象プラットフォームと投稿IDを1件ずつ指定します。

```powershell
node promotion\promote.mjs publish --platform x --id launch-x-ja --campaign promotion\campaign.example.json
```

## 提供してもらう情報

### 共通

- iVucxの本番公開URL
- X、TikTok、Instagramの公開ユーザー名
- 使用するロゴ、スクリーンショット、動画
- 投稿言語、避けたい表現、公開希望日

### X

- X DeveloperのProject/App
- 利用可能なAPIプラン
- OAuth 2.0 Client ID / Client Secret
- `tweet.read tweet.write users.read offline.access`を許可したUser Access Token
- 登録済みCallback URI

### TikTok

- TikTok for DevelopersのApp Client Key / Client Secret
- Content Posting APIの追加状況
- `video.upload`または`video.publish`の承認状況
- CreatorのAccess Token / Refresh Token / Open ID
- 登録済みRedirect URI
- 検証済みのWebドメインまたはURL prefix
- Direct Postを使う場合はAPI client auditの状況

### Instagram

推奨構成は「Instagram API with Instagram Login」です。

- Instagram Professional（BusinessまたはCreator）アカウント
- Meta App ID / App Secret
- `instagram_business_basic`と
  `instagram_business_content_publish`を許可したAccess Token
- Instagram User ID
- Meta Appに登録済みのOAuth Redirect URI
- 使用中のInstagram API version

既存アプリが「Facebook Login」方式の場合は、Facebook Page ID、
Page Access Token、Instagram Professional Account ID、および許可済み権限も必要です。

## 秘密情報の扱い

- SecretやAccess Tokenをチャット、Git、JSON原稿へ貼らない。
- `promotion/.env`へ直接保存するか、パスワードマネージャーで共有する。
- Access Tokenの画面共有・スクリーンショットを避ける。
- 接続後は不要な権限を外し、長期トークンには更新期限を記録する。
- `promotion/.promotion-state.json`は重複投稿防止用で、Git対象外。

## メディア

- TikTokの`PULL_FROM_URL`とInstagram投稿では、プラットフォームから取得可能な
  HTTPSメディアURLが必要。
- TikTokでは対象URLのドメインまたはURL prefixをDeveloper Consoleで検証する。
- Xの自動アップロードは現在画像のみ。動画はTikTok/Instagram用の縦型動画を
  手動転用するか、Xのchunked upload対応を追加してから公開する。
