#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-release.sh [macos|windows|all] [options]

Build the signed desktop release artifacts locally. The default is a full
release for the current host, including both macOS architectures, both
Windows architectures, and the architecture-selecting Windows installer.

Options:
  --notarize              Submit macOS apps to Apple notarization and staple them.
  --publish-r2            Upload all artifacts and update R2 latest.json.
  --r2-env PATH           Source R2 credentials and publish settings from PATH.
  --release-dir PATH      Write release files to PATH (default: dist/release).
  --skip-install          Do not run npm ci before building.
  --clean                 Remove the selected release directory before building.
  --tag                   Create an annotated v<version> tag after success.
  --push                  Push the current branch and the new tag to origin.
  -h, --help              Show this help.

Required for signed artifacts:
  TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or
  TAURI_SIGNING_PRIVATE_KEY_FILE and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.

Required for --notarize:
  APPLE_NOTARY_KEY_BASE64 or NOTARY_KEY_PATH, APPLE_NOTARY_KEY_ID,
  APPLE_NOTARY_ISSUER_ID. The Developer ID identity defaults to the current
  AUTO Gateway identity and can be overridden with APPLE_SIGNING_IDENTITY.

Required for --publish-r2:
  R2_ENDPOINT, R2_BUCKET, R2_PUBLIC_BASE_URL, AWS_ACCESS_KEY_ID, and
  AWS_SECRET_ACCESS_KEY. R2_ENV can be loaded with --r2-env.

Windows builds from macOS/Linux use cargo-xwin and a local NSIS installation.
Native Windows hosts use the installed MSVC toolchain directly.
EOF
}

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

platform="all"
notarize=false
publish_r2=false
skip_install=false
clean=false
create_tag=false
push_changes=false
release_dir="$root_dir/dist/release"
r2_env_file=""

if [[ $# -gt 0 && "${1:-}" != -* ]]; then
  platform="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notarize)
      notarize=true
      ;;
    --publish-r2)
      publish_r2=true
      ;;
    --r2-env)
      [[ $# -ge 2 ]] || { echo "--r2-env requires a file path." >&2; exit 2; }
      r2_env_file="$2"
      shift
      ;;
    --release-dir)
      [[ $# -ge 2 ]] || { echo "--release-dir requires a directory path." >&2; exit 2; }
      release_dir="$2"
      shift
      ;;
    --skip-install)
      skip_install=true
      ;;
    --clean)
      clean=true
      ;;
    --tag)
      create_tag=true
      ;;
    --push)
      push_changes=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$push_changes" == true && "$create_tag" != true ]]; then
  echo "--push requires --tag." >&2
  exit 2
fi

case "$platform" in
  macos|windows|all) ;;
  *)
    echo "Platform must be macos, windows, or all." >&2
    exit 2
    ;;
esac

if [[ -n "$r2_env_file" ]]; then
  if [[ ! -f "$r2_env_file" ]]; then
    echo "R2 environment file does not exist: $r2_env_file" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$r2_env_file"
  set +a
fi

# Reuse the gateway repository's existing configs/r2.env when it is supplied.
# Explicit release variables still take precedence over these aliases.
R2_ENDPOINT="${R2_ENDPOINT:-${AI_GATEWAY_SUPPORT_ATTACHMENT_R2_ENDPOINT:-}}"
R2_BUCKET="${R2_BUCKET:-${AI_GATEWAY_SUPPORT_ATTACHMENT_R2_BUCKET:-}}"
R2_PUBLIC_BASE_URL="${R2_PUBLIC_BASE_URL:-${AI_GATEWAY_SUPPORT_ATTACHMENT_CDN_BASE_URL:-}}"
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${AI_GATEWAY_SUPPORT_ATTACHMENT_R2_ACCESS_KEY_ID:-}}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${AI_GATEWAY_SUPPORT_ATTACHMENT_R2_SECRET_ACCESS_KEY:-}}"
AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${AI_GATEWAY_SUPPORT_ATTACHMENT_R2_REGION:-auto}}"
export R2_ENDPOINT R2_BUCKET R2_PUBLIC_BASE_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
command -v cargo >/dev/null || { echo "Rust cargo is required." >&2; exit 1; }
command -v rustup >/dev/null || { echo "rustup is required." >&2; exit 1; }

version="$(node -p "require('./package.json').version")"
cargo_version="$(awk -F ' = ' '/^version = / { gsub(/"/, "", $2); print $2; exit }' src-tauri/Cargo.toml)"
tauri_version="$(node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).version)")"
if [[ "$version" != "$cargo_version" || "$version" != "$tauri_version" ]]; then
  echo "Version mismatch: package.json=$version Cargo.toml=$cargo_version tauri.conf.json=$tauri_version" >&2
  exit 1
fi
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Version must use semantic version format: $version" >&2
  exit 1
fi

tag_name="v$version"
if [[ "$create_tag" == true ]]; then
  command -v git >/dev/null || { echo "Git is required for --tag." >&2; exit 1; }
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Create a commit before using --tag; the working tree is not clean." >&2
    exit 1
  fi
  if git rev-parse --verify --quiet "refs/tags/$tag_name" >/dev/null; then
    echo "Tag already exists locally: $tag_name" >&2
    exit 1
  fi
  if [[ "$push_changes" == true ]]; then
    git remote get-url origin >/dev/null || {
      echo "An origin remote is required for --push." >&2
      exit 1
    }
    if git ls-remote --exit-code --tags origin "refs/tags/$tag_name" >/dev/null 2>&1; then
      echo "Tag already exists on origin: $tag_name" >&2
      exit 1
    fi
  fi
fi

if [[ "$clean" == true ]]; then
  case "$release_dir" in
    "$root_dir/dist/release"|"$root_dir/dist/release/"*)
      rm -rf -- "$release_dir"
      ;;
    *)
      echo "--clean is restricted to dist/release to avoid deleting an unexpected directory." >&2
      exit 1
      ;;
  esac
fi
mkdir -p "$release_dir"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/autogateway-release.XXXXXX")"
trap 'rm -rf -- "$temporary_dir"' EXIT

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_FILE:-}" ]]; then
  signing_key_file="$TAURI_SIGNING_PRIVATE_KEY_FILE"
  [[ -f "$signing_key_file" ]] || { echo "Updater key file does not exist: $signing_key_file" >&2; exit 1; }
  export TAURI_SIGNING_PRIVATE_KEY="$(<"$signing_key_file")"
elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  signing_key_file="$temporary_dir/tauri-updater.key"
  printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" > "$signing_key_file"
else
  echo "Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_FILE before building." >&2
  exit 1
fi
: "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD before building.}"

if [[ "$skip_install" != true ]]; then
  npm ci
fi
npm run build

host_is_macos=false
host_is_windows=false
case "$(uname -s)" in
  Darwin) host_is_macos=true ;;
  MINGW*|MSYS*|CYGWIN*) host_is_windows=true ;;
esac

require_command() {
  command -v "$1" >/dev/null || {
    echo "Required command is missing: $1" >&2
    exit 1
  }
}

sign_updater_archive() {
  local archive="$1"
  ./node_modules/.bin/tauri signer sign \
    --private-key-path "$signing_key_file" \
    --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
    "$archive"
}

make_dmg() {
  local app_path="$1"
  local output_path="$2"
  local staging_dir="$temporary_dir/dmg-$(basename "$output_path" .dmg)"
  mkdir -p "$staging_dir"
  ditto "$app_path" "$staging_dir/AUTO Gateway Desktop.app"
  ln -s /Applications "$staging_dir/Applications"
  hdiutil create \
    -volname "AUTO Gateway Desktop" \
    -srcfolder "$staging_dir" \
    -ov \
    -format UDZO \
    "$output_path" >/dev/null
}

build_macos_target() {
  local target="$1"
  local suffix="$2"
  local app_path="src-tauri/target/$target/release/bundle/macos/AUTO Gateway Desktop.app"
  local archive="$release_dir/AUTO Gateway Desktop_${version}_${suffix}.app.tar.gz"
  local dmg="$release_dir/AUTO Gateway Desktop_${version}_${suffix}.dmg"

  rustup target add "$target"
  npm run tauri build -- --target "$target" --bundles app
  [[ -d "$app_path" ]] || { echo "macOS app was not produced: $app_path" >&2; exit 1; }
  codesign --verify --deep --strict --verbose=2 "$app_path"

  if [[ "$notarize" == true ]]; then
    APP_PATH="$app_path" bash scripts/notarize-macos.sh
  fi

  make_dmg "$app_path" "$dmg"
  tar -C "$(dirname "$app_path")" -czf "$archive" "$(basename "$app_path")"
  sign_updater_archive "$archive"
}

build_macos_universal() {
  local app_path="src-tauri/target/universal-apple-darwin/release/bundle/macos/AUTO Gateway Desktop.app"
  local dmg="$release_dir/AUTO Gateway Desktop_${version}_universal.dmg"

  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npm run tauri build -- --target universal-apple-darwin --bundles app
  [[ -d "$app_path" ]] || { echo "Universal macOS app was not produced: $app_path" >&2; exit 1; }
  codesign --verify --deep --strict --verbose=2 "$app_path"

  if [[ "$notarize" == true ]]; then
    APP_PATH="$app_path" bash scripts/notarize-macos.sh
  fi

  make_dmg "$app_path" "$dmg"
}

build_macos() {
  [[ "$host_is_macos" == true ]] || {
    echo "macOS artifacts must be built on macOS." >&2
    exit 1
  }
  require_command security
  require_command codesign
  require_command hdiutil
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: WANG JING (UFC4M35743)}"
  security find-identity -v -p codesigning | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null || {
    echo "The macOS signing identity is not available: $APPLE_SIGNING_IDENTITY" >&2
    exit 1
  }
  if [[ "$notarize" == true ]]; then
    : "${APPLE_NOTARY_KEY_ID:?Set APPLE_NOTARY_KEY_ID for notarization.}"
    : "${APPLE_NOTARY_ISSUER_ID:?Set APPLE_NOTARY_ISSUER_ID for notarization.}"
    if [[ -z "${NOTARY_KEY_PATH:-}" ]]; then
      : "${APPLE_NOTARY_KEY_BASE64:?Set APPLE_NOTARY_KEY_BASE64 or NOTARY_KEY_PATH for notarization.}"
      printf '%s' "$APPLE_NOTARY_KEY_BASE64" | base64 --decode > "$temporary_dir/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
      chmod 600 "$temporary_dir/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
      export NOTARY_KEY_PATH="$temporary_dir/AuthKey_${APPLE_NOTARY_KEY_ID}.p8"
    fi
  fi

  build_macos_target aarch64-apple-darwin aarch64
  build_macos_target x86_64-apple-darwin x64
  build_macos_universal
}

build_windows_target() {
  local target="$1"
  local suffix="$2"
  local source
  local output="$release_dir/AUTO Gateway Desktop_${version}_${suffix}-setup.exe"
  local runner_args=()

  rustup target add "$target"
  if [[ "$host_is_windows" != true ]]; then
    require_command cargo-xwin
    require_command makensis
    eval "$(cargo xwin env --target "$target")"
    runner_args=(--runner cargo-xwin)
  fi

  npm run tauri build -- --target "$target" "${runner_args[@]}" --bundles nsis
  source="$(find "src-tauri/target/$target/release/bundle/nsis" -name '*-setup.exe' -type f -print -quit)"
  [[ -n "$source" ]] || { echo "Windows installer was not produced for $target." >&2; exit 1; }
  cp "$source" "$output"
  if [[ -f "$source.sig" ]]; then
    cp "$source.sig" "$output.sig"
  else
    echo "Windows updater signature was not produced: $source.sig" >&2
    exit 1
  fi
}

build_windows_unified() {
  local payload_dir="$temporary_dir/unified-payload"
  local output="$release_dir/AUTO Gateway Desktop_${version}_setup.exe"
  require_command makensis
  mkdir -p "$payload_dir"
  cp "$release_dir/AUTO Gateway Desktop_${version}_x64-setup.exe" "$payload_dir/AUTO-Gateway-Desktop-x64-setup.exe"
  cp "$release_dir/AUTO Gateway Desktop_${version}_arm64-setup.exe" "$payload_dir/AUTO-Gateway-Desktop-arm64-setup.exe"
  makensis \
    "-DPAYLOAD_DIR=$payload_dir" \
    "-DOUTFILE=$output" \
    "-DAPP_VERSION=$version" \
    scripts/windows-unified-installer.nsi
  [[ -s "$output" ]] || { echo "Unified Windows installer was not produced." >&2; exit 1; }
}

build_windows() {
  if [[ "$host_is_windows" != true && "$host_is_macos" != true ]]; then
    echo "Windows artifacts require a Windows host or cargo-xwin on macOS/Linux." >&2
    exit 1
  fi
  build_windows_target x86_64-pc-windows-msvc x64
  build_windows_target aarch64-pc-windows-msvc arm64
  build_windows_unified
}

if [[ "$platform" == macos || "$platform" == all ]]; then
  build_macos
fi

if [[ "$platform" == windows || "$platform" == all ]]; then
  build_windows
fi

if [[ "$publish_r2" == true ]]; then
  RELEASE_DIR="$release_dir" VERSION="$version" bash scripts/publish-r2.sh
else
  echo "Release artifacts are ready in: $release_dir"
  echo "Add --publish-r2 to upload them and update latest.json."
fi

if [[ "$create_tag" == true ]]; then
  current_branch="$(git branch --show-current)"
  [[ -n "$current_branch" ]] || {
    echo "Cannot create a release tag from a detached HEAD." >&2
    exit 1
  }
  git tag -a "$tag_name" -m "Release $tag_name"
  echo "Created tag: $tag_name"
  if [[ "$push_changes" == true ]]; then
    git push origin "$current_branch"
    git push origin "$tag_name"
    echo "Pushed $current_branch and $tag_name to origin."
  fi
fi
