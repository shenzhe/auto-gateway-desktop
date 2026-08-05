#!/usr/bin/env bash
set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_PUBLIC_BASE_URL:?R2_PUBLIC_BASE_URL is required}"

mac_dmg="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_aarch64.dmg"
mac_updater="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_aarch64.app.tar.gz"
mac_signature="$mac_updater.sig"
windows_installer="$RELEASE_DIR/AUTO Gateway Desktop_${VERSION}_x64-setup.exe"
windows_signature="$windows_installer.sig"

for artifact in "$mac_dmg" "$mac_updater" "$mac_signature" "$windows_installer" "$windows_signature"; do
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

upload "$mac_dmg" "application/x-apple-diskimage" "public, max-age=31536000, immutable"
upload "$mac_updater" "application/gzip" "public, max-age=31536000, immutable"
upload "$mac_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"
upload "$windows_installer" "application/vnd.microsoft.portable-executable" "public, max-age=31536000, immutable"
upload "$windows_signature" "text/plain; charset=utf-8" "public, max-age=31536000, immutable"

manifest_path="$RELEASE_DIR/latest.json"
mac_url="$base_url/$prefix/$(basename "$mac_updater" | sed 's/ /%20/g')"
windows_url="$base_url/$prefix/$(basename "$windows_installer" | sed 's/ /%20/g')"

jq -n \
  --arg version "$VERSION" \
  --arg notes "${RELEASE_NOTES:-Bug fixes and improvements.}" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg mac_url "$mac_url" \
  --rawfile mac_signature "$mac_signature" \
  --arg windows_url "$windows_url" \
  --rawfile windows_signature "$windows_signature" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: {
      "darwin-aarch64": {
        url: $mac_url,
        signature: ($mac_signature | rtrimstr("\n"))
      },
      "windows-x86_64": {
        url: $windows_url,
        signature: ($windows_signature | rtrimstr("\n"))
      }
    }
  }' > "$manifest_path"

aws s3 cp "$manifest_path" "s3://$R2_BUCKET/$prefix/latest.json" \
  --endpoint-url "$endpoint" \
  --no-progress \
  --content-type "application/json; charset=utf-8" \
  --cache-control "no-cache"
