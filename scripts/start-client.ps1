# 后台启动 @ai-novel/client dev(只起前端)
# 默认会等 server :3000 ready 再启动,避免 Vite 起来但 API 不通
# 用法: pwsh -File scripts/start-client.ps1 [-Port 5173] [-Wait]
# 日志: tools/launcher-client.log
# PID:  tools/launcher-client.pid

[CmdletBinding()]
param(
    [int]$Port = 5173,
    [int]$ServerPort = 3000,
    [switch]$Wait
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$toolsDir = Join-Path $repoRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$logFile = Join-Path $toolsDir 'launcher-client.log'
$pidFile = Join-Path $toolsDir 'launcher-client.pid'

if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
        Write-Output "client 已在运行(PID $existing)。停掉请用 scripts/stop-client.ps1"
        exit 0
    }
}

# 等 server :3000 ready,最多 60 秒
Write-Output "[start-client] 等 server :$ServerPort ready ..."
$serverOk = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ServerPort/api/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $serverOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $serverOk) {
    throw "server :$ServerPort 60 秒内未就绪,放弃启动 client。请先确保 server 跑起来。"
}

# 后台启 client dev
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c','pnpm','--filter','@ai-novel/client','dev') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value $proc.Id
Write-Output "[start-client] 已启动 PID $($proc.Id),日志: $logFile"

if ($Wait) {
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) {
                Write-Output "[start-client] 健康: http://127.0.0.1:$Port (200)"
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Write-Warning "[start-client] 60s 内未就绪,请查看 $logFile"
    exit 1
}
