# 停止通过 start-qdrant.ps1 启动的 Qdrant 进程
# 用法: pwsh -File scripts/stop-qdrant.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$processes = Get-Process -Name qdrant -ErrorAction SilentlyContinue
if (-not $processes) {
    Write-Output "没有运行中的 Qdrant 进程。"
    exit 0
}

$processes | ForEach-Object {
    Write-Output "停止 PID $($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Write-Output "Qdrant 已停止。"
