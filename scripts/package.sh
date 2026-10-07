#!/usr/bin/env bash
# Builds the extension zips into dist/:
#   codeshelf-<version>.zip           Chrome Web Store upload. The store rejects a manifest
#                                     "key" (it assigns its own extension ID), so it's removed.
#   codeshelf-<version>-unpacked.zip  For "Load unpacked" installs (see INSTALL.md). Keeps the
#                                     "key" so every install has the same extension ID, which
#                                     Google sign-in's redirect URL depends on. Files sit in a
#                                     CodeShelf/ folder so extracting gives one folder to load.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
mkdir -p dist

# Unpacked build: extension files as-is, inside a CodeShelf/ folder.
rsync -a --exclude '.DS_Store' --exclude 'README.md' extension/ "$build/CodeShelf/"
unpacked="dist/codeshelf-$version-unpacked.zip"
rm -f "$unpacked"
(cd "$build" && zip -qr -X "$OLDPWD/$unpacked" CodeShelf)

# Store build: same files at the zip root, without "key".
python3 - "$build/CodeShelf/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.pop('key', None)
json.dump(manifest, open(path, 'w'), indent=2)
PY
store="dist/codeshelf-$version.zip"
rm -f "$store"
(cd "$build/CodeShelf" && zip -qr -X "$OLDPWD/$store" .)

echo "Built $store (Chrome Web Store)"
echo "Built $unpacked (Load unpacked)"
