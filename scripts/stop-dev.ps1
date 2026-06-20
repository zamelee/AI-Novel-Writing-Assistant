# 停止通过 start-dev.ps1 启动的 pnpm dev 进程
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$pidFile = Join-Path $repoRoot 'tools/dev.pid'

# 杀 ts-node-dev + vite + concurrently 这一棵进程树
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match 'scripts/run-with-log.cjs|src/app.ts|node_modules/vite|node_modules/concurrently|node_modules/pnpm.*dev') } |
    ForEach-Object {
        Write-Output "停止 PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
Write-Output "pnpm dev 已停止。"
