# iVucx Windows release checklist

## What is ready in this repository

- Electron desktop shell with Node integration disabled, sandboxing, context
  isolation, and a strict navigation allow-list.
- Standard Windows installer and portable build commands.
- AppX package command for the existing Microsoft Store product `provf`
  (`Store ID: 9MWNLHRPBT1N`).
- No Google, Stripe, Supabase, SMTP, or server API secret is packaged into the
  Windows application. The shell always uses the existing HTTPS Vercel app.

## Required Partner Center steps

1. Sign in at `https://partner.microsoft.com/dashboard/home` with the account
   that owns the Windows developer registration.
2. Open the existing `provf` MSIX/PWA product (`Store ID: 9MWNLHRPBT1N`).
3. Keep the assigned package identity name and publisher under `build.appx` in
   `package.json` unchanged.
4. Run `npm run dist:store`, then upload the generated `.appx` package.
5. Complete the required Store listing fields: Japanese and English
   description, category, support contact, privacy policy URL, screenshots,
   availability, pricing, and age rating.
6. Submit for certification. Microsoft performs the final signing and review.

## App listing copy draft

### Display name

iVucx

### Short description

Interactive environment for searching, reading, and verifying formal proofs.

### Japanese description

iVucx は、問題・定理の検索、引用付き AI 対話、Coq と Lean の証明編集・検証を一つにまとめたフォーマル証明環境です。保存済みの問題、定理、添付資料、証明コードを参照しながら、検証可能な証明の作成と共有を行えます。

### English description

iVucx brings formal problem and theorem search, cited AI conversations, and Coq and Lean proof editing into one workspace. Explore saved sources, inspect attachments and proof files, and create verifiable formal proofs.

## Release gates

- Run the Windows installer on a clean Windows account and test Google and
  email sign-in, Stripe checkout, file download, proof validation, and logout.
- Capture Windows desktop screenshots for the Store listing.
- Confirm the production privacy-policy link and support email before submit.
