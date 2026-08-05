#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_PUBLIC_BASE_URL:?R2_PUBLIC_BASE_URL is required}"

mac_arm64_dmg="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_aarch64.dmg"
mac_arm64_updater="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_aarch64.app.tar.gz"
mac_arm64_signature="$mac_arm64_updater.sig"
mac_x64_dmg="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_x64.dmg"
mac_x64_updater="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_x64.app.tar.gz"
mac_x64_signature="$mac_x64_updater.sig"
windows_x64_installer="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_x64-setup.exe"
windows_x64_signature="$windows_x64_installer.sig"
windows_arm64_installer="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_arm64-setup.exe"
windows_arm64_signature="$windows_arm64_installer.sig"

for artifact in "$mac_arm64_dmg" "$mac_arm64_updater" "$mac_arm64_signature" "$mac_x64_dmg" "$mac_x64_updater" "$mac_x64_signature" "$windows_x64_installer" "$windows_x64_signature" "$windows_arm64_installer" "$windows_arm64_signature"; do
  if [[ ! -s "$artifact" ]]; then
    echo "Required release artifact is missing or empty: $artifact" >&2
    exit 1
  fi
done

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "VERSION must use semantic version format." >&2
  exit 1
fi

endpoint="${R2_ENDPOINT%/}"
base_url="${R2_PUBLIC_BASE_URL%/}"
prefix="downloads/desktop"

upload() {
  local file="$1"
  local content_type="$2"
  local cache_control="$3"
  local name
  name="$(basename "$file")"
  aws s3 cp "$file" "s3://$R2_BUCKET/$prefix/$name" \
    --endpoint-url "$endpoint" \
    --no-progress \
    --content-type "$content_type" \
    --content-disposition "attachment; filename=$name" \
    --cache-control "$cache_control"
}

upload "$mac_arm64_dmg" "application/x-apple-diskimage" "public, max-age=31536000, immutable"
upload "$mac_arm64_updater" "application/gzip" "public, max-age=31536000, immutable"
upload "$mac_arm64_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"
upload "$mac_x64_dmg" "application/x-apple-diskimage" "public, max-age=31536000, immutable"
upload "$mac_x64_updater" "application/gzip" "public, max-age=31536000, immutable"
upload "$mac_x64_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"
upload "$windows_x64_installer" "application/vnd.microsoft.portable-executable" "public, max-age=31536000, immutable"
upload "$windows_x64_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"
upload "$windows_arm64_installer" "application/vnd.microsoft.portable-executable" "public, max-age=31536000, immutable"
upload "$windows_arm64_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"

manifest_path="$RELEASE_DIR/latest.json"
mac_arm64_url="$base_url/$prefix/$(basename "$mac_arm64_updater" | sed 's/ /%20/g')"
mac_x64_url="$base_url/$prefix/$(basename "$mac_x64_updater" | sed 's/ /%20/g')"
windows_x64_url="$base_url/$prefix/$(basename "$windows_x64_installer" | sed 's/ /%20/g')"
windows_arm64_url="$base_url/$prefix/$(basename "$windows_arm64_installer" | sed 's/ /%20/g')"

jq -n \
  --arg version "$VERSION" \
  --arg notes "${RELEASE_NOTES:-Bug fixes and improvements.}" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mac_arm64_url "$mac_arm64_url" \
  --rawfile mac_arm64_signature "$mac_arm64_signature" \
  --arg mac_x64_url "$mac_x64_url" \
  --rawfile mac_x64_signature "$mac_x64_signature" \
  --arg windows_x64_url "$windows_x64_url" \
  --rawfile windows_x64_signature "$windows_x64_signature" \
  --arg windows_arm64_url "$windows_arm64_url" \
  --rawfile windows_arm64_signature "$windows_arm64_signature" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": {
        url: $mac_arm64_url,
        signature: ($mac_arm64_signature | rtrimstr("\n"))
      },
      "darwin-x86_64": {
        url: $mac_x64_url,
        signature: ($mac_x64_signature | rtrimstr("\n"))
      },
      "windows-x86_64": {
        url: $windows_x64_url,
        signature: ($windows_x64_signature | rtrimstr("\n"))
      },
      "windows-aarch64": {
        url: $windows_arm64_url,
        signature: ($windows_arm64_signature | rtrimstr("\n"))
      }
    }
  }' > "$manifest_path"

aws s3 cp "$manifest_path" "s3://$R2_BUCKET/$prefix/latest.json" \
  --endpoint-url "$endpoint" \
  --no-progress \
  --content-type "application/json; charset=utf-8" \
  --cache-control "no-cache"
