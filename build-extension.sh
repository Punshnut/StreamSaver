#!/usr/bin/env bash
# build-extension.sh — builds StreamSaver for Chrome and Firefox.
# Outputs ready-to-load packages in dist/.
#
# Usage:
#   bash build-extension.sh           # build both platforms
#   bash build-extension.sh chrome    # Chrome only
#   bash build-extension.sh firefox   # Firefox only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── prerequisites ─────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required. Install from https://nodejs.org" >&2; exit 1; }
command -v zip  >/dev/null 2>&1 || { echo "Error: zip is required." >&2; exit 1; }
[[ -f manifest.json ]] || { echo "Error: manifest.json not found." >&2; exit 1; }

# Install dependencies if missing.
if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install --silent
fi

# ── version (single source of truth: manifest.json) ───────────────────────────

VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
[[ -n "$VERSION" ]] || { echo "Error: could not read version from manifest.json." >&2; exit 1; }

# Sync version to manifest.firefox.json and package.json.
sync_version() {
  local file="$1"
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('${file}', 'utf8'));
    data.version = '${VERSION}';
    fs.writeFileSync('${file}', JSON.stringify(data, null, 2) + '\n');
  "
}
sync_version manifest.firefox.json
sync_version package.json

# ── build ─────────────────────────────────────────────────────────────────────

usage() { echo "Usage: $0 [chrome|firefox]" >&2; exit 1; }
[[ $# -gt 1 ]] && usage

build_platform() {
  local platform="$1"
  local manifest_src

  case "$platform" in
    chrome)  manifest_src="manifest.json" ;;
    firefox) manifest_src="manifest.firefox.json" ;;
    *) echo "Error: unknown platform '$platform'." >&2; exit 1 ;;
  esac

  local stage_dir="build/${platform}"
  local ext; [[ "$platform" == "firefox" ]] && ext="xpi" || ext="zip"
  local out_file="dist/streamsaver-${platform}-v${VERSION}.${ext}"

  echo "Building $platform v${VERSION}..."
  rm -rf "$stage_dir"
  mkdir -p "$stage_dir/icons" dist

  # Bundle JS source modules.
  npx esbuild src/content/main.js --bundle --outfile="$stage_dir/content.js" --format=iife
  npx esbuild src/popup/main.js   --bundle --outfile="$stage_dir/popup.js"   --format=iife

  # Copy static assets.
  cp src/popup/popup.html "$stage_dir/popup.html"
  cp src/popup/styles.css "$stage_dir/styles.css"
  cp -R icons/. "$stage_dir/icons/"
  cp "$manifest_src" "$stage_dir/manifest.json"

  # Package.
  rm -f "$out_file"
  (cd "$stage_dir" && zip -r -q "../../$out_file" . -x "*.DS_Store")
  echo "  -> $out_file"
}

TARGET="${1:-all}"
case "$TARGET" in
  chrome)  build_platform chrome; echo "Done." ;;
  firefox) build_platform firefox; echo "Done." ;;
  all)     build_platform chrome; build_platform firefox; echo "Done. Both platforms built." ;;
  *) usage ;;
esac
