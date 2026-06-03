#!/usr/bin/env bash
#
# Assemble a distributable .dmg from the locally built (and ad-hoc signed) .app,
# using `hdiutil create` only — no Finder/AppleScript. Mirrors the CI release
# workflow so local and CI installers are identical in shape.
#
# Run AFTER scripts/sign-mac.sh (or via `npm run build:mac`).
#
# Usage:
#   bash scripts/make-dmg.sh                       # host arch
#   bash scripts/make-dmg.sh x86_64-apple-darwin   # a specific --target build
#
# Output: <product>_<version>_<arch>.dmg in the repo root.
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
  echo "No .app found under $bundle_dir — run the build (and sign) first." >&2
  exit 1
fi

app_name=$(basename "$app_path" .app)
version=$(node -p "require('./package.json').version")

# Derive arch token from the target triple, or from the host when no --target.
if [ -n "$target" ]; then
  arch="${target%%-*}"   # aarch64 / x86_64
else
  case "$(uname -m)" in
    arm64) arch="aarch64" ;;
    *)     arch="$(uname -m)" ;;
  esac
fi

dmg_name="${app_name// /_}_${version}_${arch}.dmg"

# Stage the .app plus an /Applications symlink for the usual drag-to-install
# layout on the mounted volume.
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
cp -R "$app_path" "$staging/"
ln -s /Applications "$staging/Applications"

echo "Creating $dmg_name from $app_path"
hdiutil create -volname "$app_name" \
  -srcfolder "$staging" \
  -ov -format UDZO \
  "$dmg_name"

echo "Done: $dmg_name"
