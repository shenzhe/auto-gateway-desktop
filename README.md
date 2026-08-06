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
- Check for signed AUTO Gateway Desktop updates at launch and every five minutes, with a manual check action, then download, verify, install, and restart from the home screen.

The desktop updater uses Tauri's signed update artifacts. The public verification key is committed in `src-tauri/tauri.conf.json`; the private signing key must stay outside the repository and be supplied only by a release machine or CI secret. The configured static manifest URL is `https://cdn.autogateway.cc/downloads/desktop/latest.json`.

The macOS bundle declares native PNG and ICNS assets, and the Windows NSIS installer explicitly uses the website-derived ICO asset for both install and uninstall screens. During an upgrade, the installer recreates desktop and Start menu shortcuts so Windows refreshes the embedded AUTO Gateway icon instead of retaining a stale shortcut icon. Local Codex status detection tolerates incomplete or custom `config.toml` files. Version 0.1.1 fixes a startup panic caused by missing `model_providers` entries in existing Codex configuration files. Version 0.1.2 introduces the guided setup-wizard UI. Version 0.1.3 applies the AUTO Gateway website color tokens and adds system-aware themes and Chinese/English UI.

On Windows, Codex installation and updates first download the full OpenAI-signed MSIX package from `codexapp.agentsmirror.com`, then use the versioned R2 replica, and finally fall back to the official Microsoft Store product through WinGet (`9PLM9XGG6VKS`) and the Store UI.

The Codex installer download uses `GET https://api.autogateway.cc/public/api/desktop/codex-version` for the platform version and download candidates. The server reads `https://codexapp.agentsmirror.com/latest/manifest` every five minutes, and synchronizes all four platform artifacts (macOS Apple Silicon, macOS Intel, Windows x64, Windows ARM64) to Cloudflare R2. The desktop app always tries the direct architecture-specific mirror URL first, then the R2 URL, then the official fallback. Windows validates the MSIX identity as `OpenAI.Codex`, and Windows validates its package signature during installation.

## Signed desktop releases

Use the same Tauri updater private key for every release. Never commit the key
or place it in the application bundle. The local release script builds all
native artifacts, validates the version files, and can publish the completed
release to R2:

```bash
export TAURI_SIGNING_PRIVATE_KEY_FILE=/secure/path/desktop-updater.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(< /secure/path/desktop-updater.key.password)"
npm run release:build -- --clean
```

The script produces these files in `release`:

- macOS Apple Silicon and Intel updater archives, signatures, and DMGs;
- one notarized/universal macOS DMG;
- Windows x64 and ARM64 NSIS installers with updater signatures;
- one Windows unified installer that selects the native payload at install time.

On macOS/Linux, Windows builds use `cargo-xwin` and a local NSIS installation.
`cargo-xwin` supplies the Windows CRT and SDK through its local cache, while
`clang-cl` and `lld-link` provide the compiler and linker. Install the tools once:

```bash
cargo install cargo-xwin --locked
brew install llvm nsis
```

On a native Windows host with Visual Studio Build Tools and the Windows SDK,
the same script uses the installed MSVC toolchain directly. Use
`npm run release:build -- windows` when only the Windows installers are needed.

To notarize the macOS applications locally, add `--notarize` and provide
`APPLE_NOTARY_KEY_BASE64` (or `NOTARY_KEY_PATH`), `APPLE_NOTARY_KEY_ID`, and
`APPLE_NOTARY_ISSUER_ID`. The default signing identity is
`Developer ID Application: WANG JING (UFC4M35743)` and can be overridden with
`APPLE_SIGNING_IDENTITY`.

R2 publishing is explicit so a local test build never changes production data:

```bash
npm run release:build -- --notarize --publish-r2 --r2-env configs/r2.env
```

After the release commit is ready, the same script can create and push the
version tag. Tagging happens only after the build and optional R2 publication
complete successfully:

```bash
npm run release:build -- --notarize --publish-r2 --r2-env configs/r2.env --tag --push
```

`--tag` requires a clean working tree and creates `v<package-version>`.
`--push` additionally pushes the current branch and tag to `origin`, which
triggers the GitHub release workflow. Existing local or remote tags are never
overwritten.

The environment file may define `R2_ENDPOINT`, `R2_BUCKET`,
`R2_PUBLIC_BASE_URL`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`. It can
also reuse the gateway repository's existing `AI_GATEWAY_SUPPORT_ATTACHMENT_R2_*`
variables; the local script maps those names automatically. The publisher uploads every versioned artifact first and writes
`downloads/desktop/latest.json` only after all required files are present. It
also publishes a versioned checksum file and the non-cached
`downloads/desktop/checksums.txt` alias.
Install the AWS CLI before publishing (`brew install awscli` on macOS).

The release job publishes four native updater artifacts and two unified download installers, then updates `latest.json` at the configured URL. The `downloads` block is for the public download page; Tauri ignores it and continues using the architecture-specific `platforms` block for safe native updates. A static manifest has this shape:

```json
{
  "version": "0.1.23",
  "notes": "Bug fixes and improvements.",
  "pub_date": "2026-08-05T00:00:00Z",
  "downloads": {
    "macos": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_universal.dmg"
    },
    "windows": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_setup.exe"
    }
  },
  "platforms": {
    "windows-x86_64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_x64-setup.exe",
      "signature": "<contents of the matching .sig file>"
    },
    "darwin-aarch64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_aarch64.app.tar.gz",
      "signature": "<contents of the matching .sig file>"
    },
    "darwin-x86_64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_x64.app.tar.gz",
      "signature": "<contents of the matching .sig file>"
    },
    "windows-aarch64": {
      "url": "https://cdn.autogateway.cc/downloads/desktop/AUTO%20Gateway%20Desktop_0.1.23_arm64-setup.exe",
      "signature": "<contents of the matching .sig file>"
    }
  }
}
```

## GitHub Actions release pipeline

`.github/workflows/desktop-release.yml` creates a distribution release without relying on a developer workstation:

1. The macOS matrix imports the existing `Developer ID Application: WANG JING (UFC4M35743)` certificate, signs, notarizes, staples, and packages both Apple Silicon and Intel apps for the updater. A separate job creates one notarized Universal DMG for downloads.
2. The Windows matrix builds x64 and ARM64 NSIS installers. A unified installer embeds both and selects the native payload on the user's machine.
3. The publish job requires all native and unified artifacts, uploads them to R2, and only then writes `downloads/desktop/latest.json`. The unified NSIS bootstrapper is packaged on Ubuntu, so publishing does not depend on a second Windows runner being available.

Create the following repository secrets before dispatching the workflow. Secrets must be set in GitHub; never commit certificates, private keys, or R2 credentials.

| Secret                               | Value                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE_BASE64`           | Base64-encoded `.p12` export of `Developer ID Application: WANG JING (UFC4M35743)`. |
| `APPLE_CERTIFICATE_PASSWORD`         | Password chosen for that `.p12` export.                                             |
| `APPLE_NOTARY_KEY_BASE64`            | Base64-encoded App Store Connect API key `.p8` file.                                |
| `APPLE_NOTARY_KEY_ID`                | App Store Connect API key ID.                                                       |
| `APPLE_NOTARY_ISSUER_ID`             | App Store Connect issuer ID.                                                        |
| `TAURI_SIGNING_PRIVATE_KEY`          | Existing Tauri updater private key contents.                                        |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri updater private key.                                         |
| `R2_ENDPOINT`                        | S3-compatible Cloudflare R2 endpoint.                                               |
| `R2_BUCKET`                          | R2 bucket name.                                                                     |
| `R2_ACCESS_KEY_ID`                   | R2 API token access key ID with object read/write permission.                       |
| `R2_SECRET_ACCESS_KEY`               | R2 API token secret access key.                                                     |

Also create the repository variable `R2_PUBLIC_BASE_URL`, for example `https://cdn.autogateway.cc`.

To authorize the current signing identity for CI, export it once on a trusted Mac as a password-protected `.p12`, base64-encode the file, and save the result as `APPLE_CERTIFICATE_BASE64`. Create a narrowly scoped App Store Connect API key with access to notarization, base64-encode its `.p8` file, and save it as `APPLE_NOTARY_KEY_BASE64`. The workflow does not use the local login keychain after those secrets are configured.

Dispatch **Desktop Release** in GitHub Actions with the version already present in `package.json`, `Cargo.toml`, and `tauri.conf.json`, or push a matching `v<version>` tag. The workflow rejects mismatched versions before building.

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
