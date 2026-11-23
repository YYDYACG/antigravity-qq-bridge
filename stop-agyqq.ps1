$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$PidFile = Join-Path $Root 'data\bridge.pid'

if (Test-Path $PidFile) {
  $pidVal = (Get-Content $PidFile -Raw).Trim()
  if ($pidVal -match '^\d+$') {
    Stop-Process -Id ([int]$pidVal) -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已停止 Antigravity QQ Bridge (PID $pidVal)"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# Clean up any node process running D:\AGYQQ\src\index.js
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessName -eq 'node.exe' -and $_.CommandLine -match 'AGYQQ|src[/\\]index\.js'
}
foreach ($p in $procs) {
  if ($p.CommandLine -match 'AGYQQ') {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已清理进程 PID $($p.ProcessId)"
  }
}
