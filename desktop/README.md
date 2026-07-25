# iVucx Windows desktop wrapper

`desktop/main.cjs` is a minimal Electron shell for the production iVucx web app.
It keeps the existing Vercel API, Google login, Supabase, Stripe, and proof
execution topology unchanged. No server credential is packaged in the app.

## Local run

```powershell
npm install
npm run desktop
```

For local web development only:

```powershell
$env:IVUCX_ALLOW_LOCAL = 'true'
$env:IVUCX_DESKTOP_URL = 'http://127.0.0.1:3000/Vucks.html'
npm run desktop
```

## Release artifacts

```powershell
npm run dist:win
npm run dist:store
```

The generated files are placed in `release/`:

- `iVucx-<version>-x64-setup.exe`: standard Windows installer.
- `iVucx-<version>-x64-portable.exe`: portable test build.
- `iVucx-<version>-x64.appx`: Store package candidate.

## Microsoft Store identity

The AppX settings are synchronized with the existing Partner Center product:
`provf` (`Store ID: 9MWNLHRPBT1N`). The identity name and publisher must stay
exactly as written in `package.json`; changing either one breaks Store package
validation.

Microsoft Store signs a submitted MSIX/AppX package after certification. The
direct-download `.exe` should use a trusted Authenticode certificate before it
is publicly hosted.
