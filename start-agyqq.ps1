param(
  [switch]$WithNapCat,
  [switch]$WithSovits,
  [switch]$OpenHub,
  [string]$QuickLoginQQ = ''
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Root = $PSScriptRoot
$LogDir = Join-Path $Root 'data\logs'
$PidFile = Join-Path $Root 'data\bridge.pid'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-TcpPort([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-BindPort([int]$Port) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

if ($WithNapCat) {
  $NapCatScript = Join-Path $Root 'napcat\start-napcat.ps1'
  if (Test-TcpPort 6099) {
    Write-Host '[1/3] 检测到项目内置 NapCatQQ (6099) 已在运行'
  } elseif (Test-Path $NapCatScript) {
    Write-Host '[1/3] 启动项目内置 NapCatQQ (WebUI 6099, OneBot WS 13001)...'
    $ncArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $NapCatScript)
    if ($QuickLoginQQ) { $ncArgs += @('-QuickLoginQQ', $QuickLoginQQ) }
    Start-Process -FilePath 'powershell' -ArgumentList $ncArgs -WorkingDirectory (Join-Path $Root 'napcat') -WindowStyle Minimized | Out-Null
  } else {
    Write-Host "[!] 未找到 $NapCatScript"
  }
}

if ($WithSovits) {
  $GsvRoot = $env:GPT_SOVITS_ROOT
  $CfgFile = Join-Path $Root 'config.json'
  if (-not $GsvRoot -and (Test-Path $CfgFile)) {
    try {
      $cfgObj = Get-Content $CfgFile -Raw | ConvertFrom-Json
      if ($cfgObj.tts.sovitsRoot) { $GsvRoot = [string]$cfgObj.tts.sovitsRoot }
    } catch {}
  }
  $PyExe = if ($GsvRoot) { Join-Path $GsvRoot 'runtime\python.exe' } else { '' }
  $YamlCfg = Join-Path $Root 'tts_infer_v5dev.yaml'
  $candidates = @(19880, 9880, 18880, 28880, 12880)
  $already = $candidates | Where-Object { Test-TcpPort $_ } | Select-Object -First 1
  if ($already) {
    Write-Host "[2/3] 检测到 GPT-SoVITS v5 已在端口 $already 运行，直接复用"
  } elseif ($PyExe -and (Test-Path $PyExe)) {
    $port = $candidates | Where-Object { Test-BindPort $_ } | Select-Object -First 1
    if ($port) {
      Write-Host "[2/3] 独立启动 GPT-SoVITS v5 (端口 $port，配置 $YamlCfg)..."
      $outLog = Join-Path $LogDir 'sovits.out.log'
      $errLog = Join-Path $LogDir 'sovits.err.log'
      Start-Process -FilePath $PyExe `
        -ArgumentList @('-u', 'api_v2.py', '-a', '127.0.0.1', '-p', "$port", '-c', $YamlCfg) `
        -WorkingDirectory $GsvRoot `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -WindowStyle Minimized | Out-Null
    }
  } else {
    Write-Host "[!] 未找到 $PyExe，跳过启动 GPT-SoVITS v5"
  }
}

Write-Host '[3/3] 启动 Antigravity QQ Bridge...'
Push-Location $Root
try {
  if ($OpenHub) {
    $proc = Start-Process -FilePath 'node' -ArgumentList @('src/index.js') -WorkingDirectory $Root -PassThru
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Start-Sleep -Seconds 2
    $tokFile = Join-Path $Root 'data\hub-token.txt'
    $tok = if (Test-Path $tokFile) { (Get-Content $tokFile -Raw).Trim() } else { '' }
    $url = if ($tok) { "http://127.0.0.1:3200/?token=$tok" } else { 'http://127.0.0.1:3200/' }
    Write-Host "[OK] 已后台启动 PID $($proc.Id)，打开控制台: $url"
    Start-Process $url
  } else {
    node src/index.js
  }
} finally {
  Pop-Location
}
