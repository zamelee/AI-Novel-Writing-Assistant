# 停止 scripts/start-client.ps1 启动的 client 进程
# 用法: pwsh -File scripts/stop-client.ps1

[CmdletBinding()]
param()

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$pidFile = Join-Path $repoRoot 'tools/launcher-client.pid'

if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
        Write-Output "[stop-client] 停止 PID $pid"
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $pidFile -Force
}

Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -and (
        $_.CommandLine -match 'node_modules.vite.bin' -or
        $_.CommandLine -match 'scripts/start-client.ps1'
    ) } |
    ForEach-Object {
        Write-Output "[stop-client] 停止 PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(60, $_.CommandLine.Length)))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Output "[stop-client] done."
