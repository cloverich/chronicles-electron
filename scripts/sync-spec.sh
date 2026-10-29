#!/bin/sh
# Vendor spec/ from chronicles-spec. Usage: scripts/sync-spec.sh [<sha>] [<chronicles-spec checkout>]
# The spec lives in cloverich/chronicles-spec; never edit spec/ here except to
# regenerate vectors (UPDATE_VECTORS=1), and copy those back to chronicles-spec.
set -eu

root=$(git rev-parse --show-toplevel)
source_repo=${2:-"$root/../chronicles-spec"}
ref=${1:-HEAD}
sha=$(git -C "$source_repo" rev-parse "$ref^{commit}")

rm -rf "$root/spec"
mkdir -p "$root/spec"
git -C "$source_repo" archive "$sha" | tar -x -C "$root/spec"
rm -rf "$root/spec/scripts" "$root/spec/AGENTS.md" "$root/spec/CLAUDE.md"
printf '%s\n' "$sha" > "$root/spec/VENDORED"
echo "spec/ vendored from chronicles-spec@$(printf %.7s "$sha")"
