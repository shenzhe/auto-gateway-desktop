#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="AUTO Gateway Desktop Dev"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/debug/bundle/macos/$APP_NAME.app"
APP_BINARY="$ROOT_DIR/src-tauri/target/debug/autogateway-desktop"
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/autogateway-desktop"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This development app script requires macOS." >&2
  exit 1
fi

case "$MODE" in
  run|debug|--debug|logs|--logs|telemetry|--telemetry|verify|--verify)
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

# Stop only this project's development bundle before replacing it.
pkill -f -- "$APP_EXECUTABLE" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
npm run tauri build -- \
  --debug \
  --config src-tauri/tauri.dev.conf.json \
  --bundles app \
  --no-sign

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "The development app bundle was not produced: $APP_BUNDLE" >&2
  exit 1
fi

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    exec /usr/bin/log stream --info --style compact --predicate 'process == "autogateway-desktop"'
    ;;
  --telemetry|telemetry)
    open_app
    exec /usr/bin/log stream --info --style compact --predicate 'process == "autogateway-desktop"'
    ;;
  --verify|verify)
    open_app
    sleep 2
    pgrep -f -- "$APP_EXECUTABLE" >/dev/null
    echo "Started $APP_NAME."
    ;;
esac
