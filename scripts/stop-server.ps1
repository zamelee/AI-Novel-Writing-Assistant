# 停止 scripts/start-server.ps1 启动的 server 进程
# 用法: pwsh -File scripts/stop-server.ps1

[CmdletBinding()]
param()

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$pidFile = Join-Path $repoRoot 'tools/launcher-server.pid'

# 先按 PID 文件精准杀
if (Test-Path $pidFile) {
    $pid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($pid -and (Get-Process -Id $pid -ErrorAction SilentlyContinue)) {
        Write-Output "[stop-server] 停止 PID $pid"
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $pidFile -Force
}

# 再扫一遍,杀掉可能漏掉的 ts-node-dev / run-with-log 等子进程
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -and (
        $_.CommandLine -match 'src/app.ts' -or
        $_.CommandLine -match 'ensure-dev-prisma.cjs' -or
        $_.CommandLine -match 'run-with-log.cjs' -or
        $_.CommandLine -match 'scripts/start-server.ps1'
    ) } |
    ForEach-Object {
        Write-Output "[stop-server] 停止 PID $($_.ProcessId): $($_.CommandLine.Substring(0, [Math]::Min(60, $_.CommandLine.Length)))"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Output "[stop-server] done."
