#!/usr/bin/env bash
# curl -fsSL https://raw.githubusercontent.com/bard1124/AgentForge/main/scripts/install.sh | bash
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  echo "AgentForge needs Node.js 22.13 or newer: https://nodejs.org" >&2
  exit 1
fi
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
curl -fsSL "https://raw.githubusercontent.com/bard1124/AgentForge/main/scripts/install.mjs" -o "$dir/install.mjs"
node "$dir/install.mjs"
