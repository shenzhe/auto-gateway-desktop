#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-release.sh [macos|windows|all] [--notarize]

Builds signed release artifacts on their native platform.

macOS:
  Builds one Universal application for Apple Silicon and Intel, signs it with
  APPLE_SIGNING_IDENTITY, and writes a DMG to dist/release. Pass --notarize to
  staple the app using:
  NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID, and APPLE_NOTARY_ISSUER_ID.
  Set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or set
  TAURI_SIGNING_PRIVATE_KEY_FILE to a protected private-key file plus its
  password, to sign the updater archive.

Windows:
  Builds the x64 NSIS installer on a Windows host. Cross-bundling a Windows
  installer from macOS is intentionally unsupported; use the GitHub Actions
  Windows runner for that artifact.
EOF
}

platform="${1:-all}"
notarize=false

if [[ "${2:-}" == "--notarize" ]]; then
  notarize=true
elif [[ -n "${2:-}" ]]; then
  usage >&2
  exit 2
fi

case "$platform" in
  macos|windows|all) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

build_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "macOS release builds must run on macOS." >&2
    exit 1
  fi

  local version app_path output_dir dmg_path
  version="$(node -p "require('./package.json').version")"
  app_path="src-tauri/target/universal-apple-darwin/release/bundle/macos/AUTO Gateway Desktop.app"
  output_dir="$root_dir/dist/release"
  dmg_path="$output_dir/AUTO Gateway Desktop_${version}_universal.dmg"

  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: WANG JING (UFC4M35743)}"
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_FILE:-}" ]]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(<"$TAURI_SIGNING_PRIVATE_KEY_FILE")"
  fi
  : "${TAURI_SIGNING_PRIVATE_KEY:?Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_FILE}"
  : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD}"
  security find-identity -v -p codesigning | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null

  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npm ci
  npm run tauri build -- --target universal-apple-darwin --bundles app

  if [[ "$notarize" == true ]]; then
    APP_PATH="$app_path" bash scripts/notarize-macos.sh
  else
    codesign --verify --deep --strict --verbose=2 "$app_path"
  fi

  mkdir -p "$output_dir"
  hdiutil create -volname "AUTO Gateway Desktop" -srcfolder "$app_path" -ov -format UDZO "$dmg_path"
  echo "macOS artifact: $dmg_path"
}

build_windows() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *)
      echo "Windows NSIS bundles must be built on a Windows host. Use the GitHub Actions Windows runner from macOS." >&2
      exit 1
      ;;
  esac

  local version source output_dir target
  version="$(node -p "require('./package.json').version")"
  output_dir="$root_dir/dist/release"

  npm ci
  npm run tauri build -- --target x86_64-pc-windows-msvc --bundles nsis

  source="$(find src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis -name '*-setup.exe' -print -quit)"
  if [[ -z "$source" ]]; then
    echo "The Windows NSIS installer was not produced." >&2
    exit 1
  fi

  mkdir -p "$output_dir"
  target="$output_dir/AUTO Gateway Desktop_${version}_x64-setup.exe"
  cp "$source" "$target"
  echo "Windows artifact: $target"
}

if [[ "$platform" == "macos" || "$platform" == "all" ]]; then
  build_macos
fi

if [[ "$platform" == "windows" || "$platform" == "all" ]]; then
  build_windows
fi
