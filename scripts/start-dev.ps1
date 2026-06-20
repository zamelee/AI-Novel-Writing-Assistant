# 后台启动 pnpm dev 整链(shared + server + client)
# 用法: pwsh -File scripts/start-dev.ps1
# 日志: tools/dev-shared.log / tools/dev-server.log / tools/dev-client.log
# PID:  tools/dev.pid

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$toolsDir = Join-Path $repoRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$sharedLog = Join-Path $toolsDir 'dev-shared.log'
$serverLog = Join-Path $toolsDir 'dev-server.log'
$clientLog = Join-Path $toolsDir 'dev-client.log'
$pidFile = Join-Path $toolsDir 'dev.pid'

# 防御:已经跑就别再起
$existing = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    Write-Output "pnpm dev 已在运行(PID $existing)。停掉请用 scripts/stop-dev.ps1"
    exit 0
}

# 用项目自带的 run-with-log 启动(会同时跑 shared + server + client)
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c','pnpm','dev') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $sharedLog `
    -RedirectStandardError "$sharedLog.err" `
    -WindowStyle Hidden `
    -PassThru
Set-Content -Path $pidFile -Value $proc.Id
Write-Output "pnpm dev 启动中,PID $($proc.Id),主日志: $sharedLog"

# 探活 server :3000
$serverOk = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $serverOk = $true; break }
    } catch { }
}
if ($serverOk) {
    Write-Output "Server 就绪: http://127.0.0.1:3000"
} else {
    Write-Warning "Server 60 秒内未就绪,请查看 $serverLog"
}

# 探活 client :5173
$clientOk = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $clientOk = $true; break }
    } catch { }
}
if ($clientOk) {
    Write-Output "Client 就绪: http://127.0.0.1:5173"
} else {
    Write-Warning "Client 60 秒内未就绪,请查看 $clientLog"
}
