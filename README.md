# AUTO Gateway Desktop

This directory contains the Tauri desktop application for onboarding AUTO Gateway users and configuring Codex.

## Current implementation slice

- A local React setup screen with browser-based PKCE sign-in and registration.
- A one-time server authorization-code exchange, followed by idempotent default-key bootstrap and automatic Codex configuration.
- Open the official AUTO Gateway registration page and official ChatGPT/Codex download page.
- Detect the official ChatGPT desktop application and local Codex configuration paths.
- Back up and merge the AUTO Gateway provider into `config.toml`.
- Back up and merge `OPENAI_API_KEY` into `auth.json`, with an explicit restore-latest-backup action.
- Open the existing AUTO Gateway console in a separate, capability-isolated WebView using a short-lived, single-use sign-in ticket.
- Check for signed AUTO Gateway Desktop updates at launch and every six hours, then download, verify, install, and restart from the home screen.

The desktop updater uses Tauri's signed update artifacts. The public verification key is committed in `src-tauri/tauri.conf.json`; the private signing key must stay outside the repository and be supplied only by a release machine or CI secret. The configured static manifest URL is `https://cdn.autogateway.cc/downloads/desktop/latest.json`.

The macOS bundle declares native PNG and ICNS assets, and the Windows NSIS installer explicitly uses the website-derived ICO asset for both install and uninstall screens. During an upgrade, the installer recreates desktop and Start menu shortcuts so Windows refreshes the embedded AUTO Gateway icon instead of retaining a stale shortcut icon. Local Codex status detection tolerates incomplete or custom `config.toml` files. Version 0.1.1 fixes a startup panic caused by missing `model_providers` entries in existing Codex configuration files. Version 0.1.2 introduces the guided setup-wizard UI. Version 0.1.3 applies the AUTO Gateway website color tokens and adds system-aware themes and Chinese/English UI.

On Windows, Codex installation and updates first download the full OpenAI-signed MSIX package from the R2 mirror and install it in place. If that mirror is unavailable, invalid, or cannot be installed, the app falls back to the official Microsoft Store product through WinGet (`9PLM9XGG6VKS`) and then the Store UI.

The Codex installer download uses `GET https://api.autogateway.cc/public/api/desktop/codex-version` for the platform version and download candidates. The server mirrors the official macOS DMG and the Windows x64 MSIX from `Wangnov/codex-app-mirror` to Cloudflare R2 every three hours. The desktop app downloads the advertised R2 `downloadUrl` first. Windows validates the MSIX identity as `OpenAI.Codex`, and Windows validates its package signature during installation. On Windows, an unavailable or failed R2 package falls back to Microsoft Store; on macOS, the official DMG URL remains the final fallback.

## Signed desktop releases

Create updater artifacts with the same private key for every release. Do not commit the key or place it in the application bundle:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(< /secure/path/desktop-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< /secure/path/desktop-updater.key.password)" npm run tauri build -- --target x86_64-pc-windows-msvc --runner cargo-xwin --bundles nsis
TAURI_SIGNING_PRIVATE_KEY="$(< /secure/path/desktop-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< /secure/path/desktop-updater.key.password)" npm run tauri build -- --bundles app
```

The Windows package can be built from macOS with `cargo-xwin` 0.23 or newer. It supplies the Windows CRT and SDK through the local xwin cache, while `clang-cl` and `lld-link` provide the compiler and linker. Install the tool and LLVM/NSIS once, then run:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin --locked
eval "$(cargo xwin env --target x86_64-pc-windows-msvc)"
TAURI_SIGNING_PRIVATE_KEY="$(< /secure/path/desktop-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< /secure/path/desktop-updater.key.password)" npm run tauri build -- --target x86_64-pc-windows-msvc --runner cargo-xwin --bundles nsis
```

On a native Windows release host with Visual Studio Build Tools and the Windows SDK installed, use the same Tauri command without `--runner cargo-xwin`.

The release job must publish each generated installer artifact and its `.sig` file, then update `latest.json` at the configured URL. A static manifest has this shape:

```json
{
  "version": "0.1.23",
  "notes": "Bug fixes and improvements.",
  "pub_date": "2026-08-05T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_x64-setup.exe",
      "signature": "<contents of the matching .sig file>"
    },
    "darwin-aarch64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_aarch64.app.tar.gz",
      "signature": "<contents of the matching .sig file>"
    }
  }
}
```

## GitHub Actions release pipeline

`.github/workflows/desktop-release.yml` creates a distribution release without relying on a developer workstation:

1. The macOS job imports the existing `Developer ID Application: WANG JING (UFC4M35743)` certificate, signs the Apple Silicon app, submits it to Apple notarization, staples the accepted ticket to the app, and produces a DMG plus a Tauri updater archive.
2. The Windows job builds the x64 NSIS installer on a native Windows runner and creates its Tauri updater signature.
3. The publish job downloads both verified artifacts, uploads them to R2, and only then writes `downloads/desktop/latest.json`. This prevents the updater from seeing a release with one platform missing.

Create the following repository secrets before dispatching the workflow. Secrets must be set in GitHub; never commit certificates, private keys, or R2 credentials.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_BASE64` | Base64-encoded `.p12` export of `Developer ID Application: WANG JING (UFC4M35743)`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password chosen for that `.p12` export. |
| `APPLE_NOTARY_KEY_BASE64` | Base64-encoded App Store Connect API key `.p8` file. |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID. |
| `APPLE_NOTARY_ISSUER_ID` | App Store Connect issuer ID. |
| `TAURI_SIGNING_PRIVATE_KEY` | Existing Tauri updater private key contents. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri updater private key. |
| `R2_ENDPOINT` | S3-compatible Cloudflare R2 endpoint. |
| `R2_BUCKET` | R2 bucket name. |
| `R2_ACCESS_KEY_ID` | R2 API token access key ID with object read/write permission. |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret access key. |

Also create the repository variable `R2_PUBLIC_BASE_URL`, for example `https://cdn.autogateway.cc`.

To authorize the current signing identity for CI, export it once on a trusted Mac as a password-protected `.p12`, base64-encode the file, and save the result as `APPLE_CERTIFICATE_BASE64`. Create a narrowly scoped App Store Connect API key with access to notarization, base64-encode its `.p8` file, and save it as `APPLE_NOTARY_KEY_BASE64`. The workflow does not use the local login keychain after those secrets are configured.

Dispatch **Desktop Release** in GitHub Actions with the version already present in `package.json`, `Cargo.toml`, and `tauri.conf.json`, or push a matching `desktop-v<version>` tag. The workflow rejects mismatched versions before building.

## Standalone repository migration

The `desktop/` directory is already self-contained: it owns its React package, Tauri Rust crate, assets, and build instructions. Once a destination remote is available, preserve its history with a subtree split from the main repository:

```bash
git subtree split --prefix=desktop -b desktop-main
git push <desktop-remote> desktop-main:main
```

After the first export, changes can move in either direction without a nested repository:

```bash
git subtree push --prefix=desktop <desktop-remote> main
git subtree pull --prefix=desktop <desktop-remote> main --squash
```

The main repository can keep the directory during the transition, or replace it with a submodule after the standalone repository is verified. No remote is configured in this checkout, so this change does not push or create a second repository implicitly.

## Development

Install a current Rust toolchain, then run:

```bash
npm install
npm run tauri dev
```

The frontend can be checked independently with `npm run build`.
