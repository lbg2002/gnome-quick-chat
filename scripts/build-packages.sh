#!/usr/bin/env bash
# Build the official user-installable GNOME extension ZIP and system-wide .deb.
# This script never installs files or changes the user's existing extension.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

out_dir="${1:-dist}"
mkdir -p -- "$out_dir"
out_dir="$(cd "$out_dir" && pwd -P)"

version="$(python3 - <<'PY'
import json,re
pkg=json.load(open('package.json',encoding='utf-8'))
meta=json.load(open('metadata.json',encoding='utf-8'))
v=pkg['version']
assert re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',v), v
assert meta.get('version-name')==v, 'package.json and metadata.json must agree'
assert meta.get('uuid')=='quick-chat@lbg2002.github.io'
print(v)
PY
)"
command -v dpkg-deb >/dev/null
command -v glib-compile-schemas >/dev/null

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
root="$tmp/deb"
target="$root/usr/share/gnome-shell/extensions/quick-chat@lbg2002.github.io"
mkdir -p -- "$target" "$root/DEBIAN"

# Keep the two installers byte-for-byte consistent. The ZIP contains exactly
# the GNOME extension root (not the enclosing uuid directory); Debian installs
# the same files to /usr/share. Avoid installing a complete desktop in CI.
python3 - "$target" <<'PY'
import pathlib,shutil,sys
src=pathlib.Path.cwd()
dst=pathlib.Path(sys.argv[1])
for name in (
    'metadata.json', 'extension.js', 'prefs.js', 'backendClient.js',
    'protocol.js', 'zcodeBridge.cjs', 'stylesheet.css',
):
    shutil.copy2(src/name,dst/name)
for directory in ('backends', 'core', 'runtime', 'ui'):
    (dst/directory).mkdir()
    for js in sorted((src/directory).glob('*.js')):
        shutil.copy2(js,dst/directory/js.name)
(dst/'schemas').mkdir()
for schema in sorted((src/'schemas').glob('*.xml')):
    shutil.copy2(schema,dst/'schemas'/schema.name)
PY
glib-compile-schemas --strict "$target/schemas"
test -f "$target/metadata.json"
test -f "$target/extension.js"
test -f "$target/schemas/org.gnome.shell.extensions.quick-chat.gschema.xml"
test -f "$target/schemas/gschemas.compiled"

zip="$out_dir/quick-chat@lbg2002.github.io.shell-extension.zip"
python3 - "$target" "$zip" <<'PY'
import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for file in sorted(root.rglob('*')):
        if file.is_file() and not file.is_symlink():
            z.write(file, file.relative_to(root).as_posix())
PY
test -s "$zip"

python3 - "$target/metadata.json" "$version" <<'PY'
import json,sys
meta=json.load(open(sys.argv[1],encoding='utf-8'))
assert meta['version-name']==sys.argv[2]
assert meta['shell-version']==['50']
PY

cat > "$root/DEBIAN/control" <<EOF
Package: gnome-shell-extension-quick-chat
Version: $version
Section: gnome
Priority: optional
Architecture: all
Maintainer: Quick Chat Contributors <lbg2002@users.noreply.github.com>
Depends: gnome-shell (>= 50), gjs, gir1.2-soup-3.0, libglib2.0-bin
Homepage: https://github.com/lbg2002/gnome-quick-chat
Description: Quick Chat GNOME 50 native AI assistant
 A GNOME Shell top-bar assistant with ZCode, DeepSeek Harness (DSH),
 Codex, and OpenAI-compatible API backends.
EOF

deb="$out_dir/gnome-shell-extension-quick-chat_${version}_all.deb"
dpkg-deb --root-owner-group --build "$root" "$deb"
(
    cd "$out_dir"
    sha256sum "$(basename "$zip")" "$(basename "$deb")" > SHA256SUMS
)
echo "✓ ZIP: $zip"
echo "✓ DEB: $deb"
echo "✓ SHA256SUMS: $out_dir/SHA256SUMS"
