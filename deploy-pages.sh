#!/usr/bin/env bash
# Publish the static app to the gh-pages branch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${REMOTE:-origin}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$ROOT/public/." "$TMP/"
cd "$TMP"
git init -b gh-pages >/dev/null
git config user.name "${GIT_AUTHOR_NAME:-$(git -C "$ROOT" config user.name)}"
git config user.email "${GIT_AUTHOR_EMAIL:-$(git -C "$ROOT" config user.email)}"
git config http.postBuffer 52428800
git add .
git commit -q -m "Deploy Alya's Reader"
git remote add origin "$(git -C "$ROOT" remote get-url "$REMOTE")"
git push -f origin gh-pages
echo "Deployed to https://hidzirtawin.github.io/alyas-reader/"
