# 后台启动本地 Qdrant(无 Docker)
# 用法:
#   pwsh -File scripts/start-qdrant.ps1                  # 默认 127.0.0.1:6333
#   pwsh -File scripts/start-qdrant.ps1 -Port 6333       # 自定义端口
# 数据与快照默认放在 tools/qdrant/storage,日志在 tools/qdrant/qdrant.log

[CmdletBinding()]
param(
    [string]$BindHost = '127.0.0.1',
    [int]$Port = 6333,
    [int]$GrpcPort = 6334,
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$qdrantDir = Join-Path $repoRoot 'tools/qdrant'
$qdrantExe = Join-Path $qdrantDir 'qdrant.exe'
$storageDir = Join-Path $qdrantDir 'storage'
$logFile = Join-Path $qdrantDir 'qdrant.log'
$pidFile = Join-Path $qdrantDir 'qdrant.pid'

if (-not (Test-Path $qdrantExe)) {
    throw "Qdrant 二进制不存在: $qdrantExe。请先下载并解压到 tools/qdrant/。"
}

# 默认配置:监听本机、关掉 telemetry、把 storage 放在项目内
$configPath = Join-Path $qdrantDir 'config.yaml'
@"
service:
  host: $BindHost
  http_port: $Port
  grpc_port: $GrpcPort
  enable_telemetry: false
storage:
  storage_path: $storageDir
"@ | Set-Content -Path $configPath -Encoding UTF8

# 已在跑就直接提示
$existing = Get-Process -Name qdrant -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -eq $qdrantExe
} | Select-Object -First 1
if ($existing) {
    Write-Output "Qdrant 已经在运行(PID $($existing.Id))。健康检查: http://$BindHost`:$Port/healthz"
    if ($Wait) { Start-Sleep -Seconds 1 }
    exit 0
}

New-Item -ItemType Directory -Force -Path $storageDir | Out-Null

# 启动并把 stdout/stderr 写到 log,完全后台
$proc = Start-Process -FilePath $qdrantExe `
    -ArgumentList @('--config-path', $configPath) `
    -WorkingDirectory $qdrantDir `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $pidFile -Value $proc.Id

Write-Output "Qdrant 已启动,PID $($proc.Id),日志: $logFile"

if ($Wait) {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri "http://$BindHost`:$Port/healthz" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) {
                Write-Output "Qdrant 健康: http://$BindHost`:$Port/healthz (200)"
                exit 0
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    Write-Warning "Qdrant 启动超时(30s),请查看 $logFile"
    exit 1
}
