#!/usr/bin/env bash
# Builds dist/codeshelf-<version>.zip for upload to the Chrome Web Store.
# The store rejects a manifest "key" (it assigns its own extension ID), so it's removed here.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

rsync -a --exclude '.DS_Store' --exclude 'README.md' extension/ "$build/"
python3 - "$build/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.pop('key', None)
json.dump(manifest, open(path, 'w'), indent=2)
PY

mkdir -p dist
out="dist/codeshelf-$version.zip"
rm -f "$out"
(cd "$build" && zip -qr -X "$OLDPWD/$out" .)
echo "Built $out"
unzip -l "$out"
