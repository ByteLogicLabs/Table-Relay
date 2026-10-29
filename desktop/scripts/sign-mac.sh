#!/usr/bin/env bash
#
# Ad-hoc sign + de-quarantine the locally built macOS .app so it launches
# without the "is damaged and can't be opened" Gatekeeper error. Mirrors the
# CI release workflow's signing step.
#
# Usage:
#   bash scripts/sign-mac.sh                 # host arch (default release dir)
#   bash scripts/sign-mac.sh x86_64-apple-darwin   # a specific --target build
#
# This is NOT notarization — it just makes the build runnable on this machine
# (and on any Apple Silicon Mac, which requires at least an ad-hoc signature).
set -euo pipefail

# This is a virtual Cargo workspace (root Cargo.toml), so the target dir lives
# at the repo root, NOT under src-tauri/.
target="${1:-}"
if [ -n "$target" ]; then
  bundle_dir="target/${target}/release/bundle/macos"
else
  bundle_dir="target/release/bundle/macos"
fi

app_path=$(find "$bundle_dir" -maxdepth 1 -name '*.app' 2>/dev/null | head -n1)
if [ -z "$app_path" ]; then
  echo "No .app found under $bundle_dir — did 'tauri build' succeed?" >&2
  exit 1
fi

echo "Ad-hoc signing: $app_path"
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

# Strip quarantine in case the build dir inherited it (e.g. from a downloaded
# dependency). Harmless if the attribute isn't present.
xattr -dr com.apple.quarantine "$app_path" 2>/dev/null || true

echo "Done. You can run it directly:"
echo "  open \"$app_path\""
