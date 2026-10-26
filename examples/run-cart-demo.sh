#!/usr/bin/env bash
# Copies the cart demo into a scratch git repo and hands the fix to a worker.
#   ./examples/run-cart-demo.sh            # Cursor, needs `agentforge login` or CURSOR_API_KEY
#   ./examples/run-cart-demo.sh --claude   # same task driven from Claude Code via /forge
#   WORKER=echo ./examples/run-cart-demo.sh  # offline dry run with the example plugin
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/cf-cart-XXXXXX")"
cp -R "$root/examples/cart-demo/." "$work/"
git -C "$work" init -q
git -C "$work" add -A
git -C "$work" -c user.email=demo@agentforge -c user.name=demo commit -qm "cart demo"
echo "demo repo: $work"

task="The cart's SAVE10 code applies its 10% discount twice; fix it. Also add a BULK10 code: 10% off when the total item quantity is at least 10, no discount otherwise. Add tests for both."

if [[ "${1:-}" == "--claude" ]]; then
  mkdir -p "$work/.claude/commands"
  cp "$root/commands/forge.md" "$work/.claude/commands/forge.md"
  config="$work/.claude-mcp.json"
  printf '{"mcpServers":{"agentforge":{"command":"%s","args":["%s/dist/cli.js","serve"],"env":{"NODE_NO_WARNINGS":"1"}}}}' "$(command -v node)" "$root" > "$config"
  cd "$work"
  exec claude -p --mcp-config "$config" --strict-mcp-config \
    --allowedTools "mcp__agentforge__*" Read Grep Glob \
    --disallowedTools Edit Write MultiEdit NotebookEdit \
    "/forge $task Acceptance: npm test passes."
fi

if [[ "${WORKER:-cursor}" == "echo" ]]; then
  export CLAUDEFORGE_WORKERS="$root/examples/workers/echo-worker.mjs"
  exec node "$root/dist/cli.js" run --cwd "$work" --worker echo "$task"
fi

exec node "$root/dist/cli.js" run --cwd "$work" --verify "npm test" --acceptance "npm test passes" "$task"
