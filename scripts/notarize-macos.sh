#!/usr/bin/env bash
set -euo pipefail

: "${APP_PATH:?APP_PATH is required}"
: "${NOTARY_KEY_PATH:?NOTARY_KEY_PATH is required}"
: "${APPLE_NOTARY_KEY_ID:?APPLE_NOTARY_KEY_ID is required}"
: "${APPLE_NOTARY_ISSUER_ID:?APPLE_NOTARY_ISSUER_ID is required}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "The macOS application bundle does not exist: $APP_PATH" >&2
  exit 1
fi

submission_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/autogateway-notary.XXXXXX")"
submission_zip="$submission_dir/AUTO-Gateway-Desktop.zip"

ditto -c -k --keepParent "$APP_PATH" "$submission_zip"
xcrun notarytool submit "$submission_zip" \
  --key "$NOTARY_KEY_PATH" \
  --key-id "$APPLE_NOTARY_KEY_ID" \
  --issuer "$APPLE_NOTARY_ISSUER_ID" \
  --wait
xcrun stapler staple "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
