# irm https://raw.githubusercontent.com/bard1124/AgentForge/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "AgentForge needs Node.js 22.13 or newer: https://nodejs.org"
  exit 1
}
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "agentforge-install-$([guid]::NewGuid()).mjs"
try {
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/bard1124/AgentForge/main/scripts/install.mjs" -OutFile $tmp
  node $tmp
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
