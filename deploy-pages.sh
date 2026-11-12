#!/usr/bin/env bash
# Publish the static app to the gh-pages branch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${REMOTE:-origin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A unique build stamp per deploy so browsers fetch fresh HTML/JS/CSS
# instead of holding on to a cached copy. The in-app update prompt
# compares this against version.json.
BUILD="$(date -u +%Y%m%d%H%M)-$(git -C "$ROOT" rev-parse --short HEAD)"

cp -R "$ROOT/public/." "$TMP/"
find "$TMP" -name '.DS_Store' -delete

python3 - "$TMP" "$BUILD" <<'PY'
import json, pathlib, re, sys

tmp = pathlib.Path(sys.argv[1])
build = sys.argv[2]
index = tmp / 'index.html'
html = index.read_text()
html = re.sub(r'(<meta name="app-build" content=")[^"]*(")', rf'\g<1>{build}\g<2>', html)
html = re.sub(r'\?v=[^"\']*', f'?v={build}', html)
index.write_text(html)

# Stamp every internal module import with this build. GitHub Pages keeps its own
# HTTP cache for a few minutes, so without this the browser can run an old copy
# of one module next to a new copy of another and the app misbehaves.
# Only same-folder app modules are stamped; vendored runtimes keep their
# immutable URLs so a 44 MB Piper bundle is never re-downloaded for this.
specifier = re.compile(r"""(from\s+|import\s*\()(['"])(\./[\w./-]+\.js)(?:\?v=[^'"]*)?(['"])""")
for path in (tmp / 'js').rglob('*.js'):
    source = path.read_text()
    stamped = specifier.sub(
        lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}?v={build}{m.group(4)}', source)
    if stamped != source:
        path.write_text(stamped)

(tmp / 'version.json').write_text(json.dumps({'build': build, 'name': "Alya's Reader"}) + '\n')
sw = tmp / 'sw.js'
if sw.exists():
    sw.write_text(sw.read_text().replace('__BUILD__', build))
print(f'build {build}')
PY

cd "$TMP"
git init -b gh-pages >/dev/null
git config user.name "${GIT_AUTHOR_NAME:-$(git -C "$ROOT" config user.name)}"
git config user.email "${GIT_AUTHOR_EMAIL:-$(git -C "$ROOT" config user.email)}"
git config http.postBuffer 52428800
git add .
git commit -q -m "Deploy Alya's Reader $BUILD"
git remote add origin "$(git -C "$ROOT" remote get-url "$REMOTE")"
git push -f origin gh-pages
echo "Deployed $BUILD to https://hidzirtawin.github.io/alyas-reader/"
