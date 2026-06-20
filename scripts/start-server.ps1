# 后台启动 @ai-novel/server dev(只起后端,不走 concurrently)
# 用法: pwsh -File scripts/start-server.ps1 [-Wait]
# 日志: tools/launcher-server.log
# PID:  tools/launcher-server.pid

[CmdletBinding()]
param(
    [int]$Port = 3000,
    [switch]$Wait
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$toolsDir = Join-Path $repoRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$logFile = Join-Path $toolsDir 'launcher-server.log'
$pidFile = Join-Path $toolsDir 'launcher-server.pid'

# 已在跑就提示
if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
        Write-Output "server 已在运行(PID $existing)。停掉请用 scripts/stop-server.ps1"
        exit 0
    }
}

# 先把 shared 编译一次,避免 server 启动时缺类型
Write-Output "[start-server] 编译 @ai-novel/shared ..."
$sharedBuild = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c','pnpm','--filter','@ai-novel/shared','build') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput (Join-Path $toolsDir 'launcher-shared-build.log') `
    -RedirectStandardError (Join-Path $toolsDir 'launcher-shared-build.err') `
    -WindowStyle Hidden `
    -Wait -PassThru
if ($sharedBuild.ExitCode -ne 0) {
    throw "@ai-novel/shared build 失败,请查看 tools/launcher-shared-build.err"
}

# 后台启 server dev
$proc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c','pnpm','--filter','@ai-novel/server','dev') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value $proc.Id
Write-Output "[start-server] 已启动 PID $($proc.Id),日志: $logFile"

if ($Wait) {
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) {
                Write-Output "[start-server] 健康: http://127.0.0.1:$Port/api/health (200)"
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    Write-Warning "[start-server] 60s 内未就绪,请查看 $logFile"
    exit 1
}
