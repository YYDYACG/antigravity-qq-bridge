$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root = $PSScriptRoot
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host '[错误] 未检测到 Node.js，请先安装 Node.js >= 22.13.0 (https://nodejs.org/) 后重试。' -ForegroundColor Red
  exit 1
}

Push-Location $Root
try {
  & node (Join-Path $Root 'scripts\install.mjs') @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
