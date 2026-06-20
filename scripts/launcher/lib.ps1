# AI-Novel Launcher 共享库(可被 dot-source,也可被 launcher.ps1 入口引用)
# 暴露:Services / LogBuffer / Refresh-LogStreams / Render / Show-Help / Restart-Service / Stop-All / Start-All / Push-Log / Test-ServiceHealth

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
[Console]::InputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$toolsDir = Join-Path $repoRoot 'tools'
$logsRoot = Join-Path $repoRoot '.logs'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$Reset   = "`e[0m"  # ANSI reset(嵌入字符串用)
$Bold    = "`e[1m"  # ANSI bold(嵌入字符串用)
$Dim     = "`e[2m"  # ANSI dim(嵌入字符串用)
$Green   = "`e[32m"
$Yellow  = "`e[33m"
$Red     = "`e[31m"
$Cyan    = "`e[36m"
$Magenta = "`e[35m"
$Gray    = "`e[90m"

$global:Services = @{
    qdrant = @{ pidFile = (Join-Path $toolsDir 'qdrant.pid'); logFile = (Join-Path $toolsDir 'qdrant.log'); port = 6333; healthPath = '/healthz'; label = 'qdrant'; tag = '[qdrant]'; color = $Magenta }
    server = @{ pidFile = (Join-Path $toolsDir 'launcher-server.pid'); logFile = (Join-Path $toolsDir 'launcher-server.log'); port = 3000; healthPath = '/api/health'; label = 'server'; tag = '[server]'; color = $Green }
    client = @{ pidFile = (Join-Path $toolsDir 'launcher-client.pid'); logFile = (Join-Path $toolsDir 'launcher-client.log'); port = 5173; healthPath = '/'; label = 'client'; tag = '[client]'; color = $Cyan }
}

$global:LogBuffer = New-Object System.Collections.Generic.List[string]
$global:LogBufferMax = 30
$global:LastRenderLines = 0
$global:LlmFile = $null
$global:LlmOffset = 0
$global:LlmLastSeen = $null
$global:LlmEnabled = $true
$global:ShouldExit = $false
$global:RepoRoot = $repoRoot
$global:ToolsDir = $toolsDir
$global:LogsRoot = $logsRoot

function Test-ServiceHealth {
    param($svc)
    $procId = $null
    $alive = $false
    if ($svc.label -eq 'qdrant') {
        # qdrant.exe 实际是 qdrant.exe 自身进程,不通过 pid 文件判断
        $q = Get-Process -Name qdrant -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($q) { $procId = $q.Id; $alive = $true }
    } else {
        if (Test-Path $svc.pidFile) { $procId = Get-Content $svc.pidFile -ErrorAction SilentlyContinue }
        if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { $alive = $true }
    }
    $httpOk = $false
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $svc.port, $svc.healthPath) -UseBasicParsing -TimeoutSec 1
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { $httpOk = $true }
    } catch { }
    return [pscustomobject]@{
        pid = $procId
        alive = $alive
        httpOk = $httpOk
        ok = ($alive -and $httpOk)
    }
}

function Get-LlmFile {
    $dir = Join-Path $global:LogsRoot (Get-Date -Format 'yyyy-MM-dd')
    if (-not (Test-Path $dir)) { return $null }
    $latest = Get-ChildItem $dir -Filter '*.llm.jsonl' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    return $latest
}

function Format-LlmLine($raw) {
    try {
        $j = $raw | ConvertFrom-Json -ErrorAction Stop
        $route = if ($j.route) { $j.route } else { $j.path }
        $status = if ($j.statusCode) { $j.statusCode } else { $j.status }
        $dur = if ($j.durationMs) { "$($j.durationMs)ms" } else { '' }
        $inT = if ($null -ne $j.inputTokens) { " in=$($j.inputTokens)" } else { '' }
        $outT = if ($null -ne $j.outputTokens) { " out=$($j.outputTokens)" } else { '' }
        $provider = if ($j.provider) { " $($j.provider)" } else { '' }
        $model = if ($j.model) { "/$($j.model)" } else { '' }
        $ts = ''
        if ($j.timestamp) {
            try { $ts = ([DateTime]$j.timestamp).ToString('HH:mm:ss') } catch { $ts = '' }
        }
        return ("{0} {1}{2,-28} {3} {4,-5} {5}{6}{7}{8}" -f $ts, '[llm]', ($route + $provider + $model), $status, $dur, '', $inT, $outT, '').TrimEnd()
    } catch {
        return "[llm] $($raw.Substring(0, [Math]::Min(140, $raw.Length)))"
    }
}

function Push-Log {
    param([string]$line)
    $global:LogBuffer.Add($line) | Out-Null
    while ($global:LogBuffer.Count -gt $global:LogBufferMax) {
        $global:LogBuffer.RemoveAt(0) | Out-Null
    }
}

function Refresh-LogStreams {
    foreach ($key in 'qdrant','server','client') {
        $svc = $global:Services[$key]
        if (Test-Path $svc.logFile) {
            try {
                $lastLines = Get-Content $svc.logFile -Tail 3 -ErrorAction SilentlyContinue
                foreach ($l in $lastLines) {
                    $trim = $l.TrimEnd()
                    if ($trim) { Push-Log ("{0} {1}" -f $svc.tag, $trim) }
                }
            } catch { }
        }
    }
    if ($global:LlmEnabled) {
        $f = Get-LlmFile
        if ($f -and $f.FullName -ne $global:LlmFile) {
            $global:LlmFile = $f.FullName
            $global:LlmOffset = 0
        }
        if ($global:LlmFile -and (Test-Path $global:LlmFile)) {
            try {
                $size = (Get-Item $global:LlmFile).Length
                if ($size -lt $global:LlmOffset) { $global:LlmOffset = 0 }
                if ($size -gt $global:LlmOffset) {
                    $stream = [System.IO.File]::Open($global:LlmFile, 'Open', 'Read', 'ReadWrite')
                    $stream.Position = $global:LlmOffset
                    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                    while (-not $reader.EndOfStream) {
                        $line = $reader.ReadLine()
                        if ($line) {
                            $global:LlmLastSeen = Get-Date
                            Push-Log (Format-LlmLine $line)
                        }
                    }
                    $global:LlmOffset = $stream.Position
                    $reader.Close()
                    $stream.Close()
                }
            } catch { }
        }
    }
}

function Render {
    try { Clear-Host } catch { }
    try { $width = [Math]::Max(60, [Console]::WindowWidth - 1) } catch { $width = 80 }
    Write-Host ("=" * $width)   
    Write-Host "$($Bold) AI-Novel Launcher$($Reset)" -NoNewline
    Write-Host "[H]帮助 [Q]退出"$Dim
    Write-Host ("=" * $width)   
    foreach ($key in 'server','client','qdrant') {
        $svc = $global:Services[$key]
        $h = Test-ServiceHealth $svc
        $indicator = if ($h.ok) { "$($Green)●$($Reset)" } elseif ($h.alive) { "$($Yellow)●$($Reset)" } else { "$($Red)●$($Reset)" }
        $status = if ($h.ok) { "✓ healthy" } elseif ($h.alive) { "▲ running" } else { "✗ stopped" }
        $pidStr = if ($h.pid) { "PID $($h.pid)" } else { "       " }
        Write-Host (" {0} {1,-7} {2,-13} :{3,-5} {4}" -f $indicator, $svc.label, $pidStr, $svc.port, $status)
    }
    $llmInfo = "OFF"
    if ($global:LlmEnabled) {
        if ($global:LlmLastSeen) {
            $ago = ((Get-Date) - $global:LlmLastSeen).TotalSeconds
            $llmInfo = "last: $([int]$ago)s ago"
        } else {
            $llmInfo = "waiting ..."
        }
    }
    Write-Host (" {0} {1,-7} {2}" -f "$($Magenta)●$($Reset)", "llm", $llmInfo)
    Write-Host ("-" * $width)   
    Write-Host (" [R]estart all   [1] server   [2] client   [3] qdrant   [O]pen browser")   
    Write-Host (" [L]lm toggle    [C]lear log  [H]elp")   
    Write-Host ("-" * $width)   
    foreach ($line in $global:LogBuffer) {
        $color = $Gray
        if ($line -match '\[server\]') { $color = $Green }
        elseif ($line -match '\[client\]') { $color = $Cyan }
        elseif ($line -match '\[qdrant\]') { $color = $Magenta }
        elseif ($line -match '\[llm\]') { $color = $Yellow }
        elseif ($line -match 'error|Error|ERROR|✗') { $color = $Red }
        $trim = if ($line.Length -gt ($width - 2)) { $line.Substring(0, $width - 5) + ' ...' } else { $line }
        Write-Host (" {0}{1}{2}" -f $color, $trim, $Reset)
    }
    Write-Host ("-" * $width)   
    Write-Host "$($Dim) 按键:$($Reset) " -NoNewline
}

function Show-Help {
    try { Clear-Host } catch { }
    Write-Host ""
    Write-Host "  AI-Novel Launcher 快捷键"$Bold
    Write-Host ""
    Write-Host "    R   重启所有服务(server + client + qdrant)"   
    Write-Host "    1   重启 server"   
    Write-Host "    2   重启 client"   
    Write-Host "    3   重启 qdrant"   
    Write-Host "    O   打开浏览器 http://localhost:5173"   
    Write-Host "    L   切换 LLM 栏(开/关)"   
    Write-Host "    C   清空日志区"   
    Write-Host "    H   显示帮助"   
    Write-Host "    Q   退出 launcher(会停所有服务)"   
    Write-Host ""
    Write-Host "  日志文件:"$Bold
    Write-Host "    tools/qdrant.log"
    Write-Host "    tools/launcher-server.log"
    Write-Host "    tools/launcher-client.log"
    Write-Host "    .logs/<date>/*.llm.jsonl"
    Write-Host ""
    Write-Host "  按任意键返回..."$Dim
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

function Restart-Service {
    param([string]$name)
    Push-Log "[launcher] 重启 $name ..."
    switch ($name) {
        'qdrant' { & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-qdrant.ps1') | Out-Null; Start-Sleep -Seconds 1; & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-qdrant.ps1') -Wait | Out-Null }
        'server' { & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-server.ps1') | Out-Null; Start-Sleep -Seconds 1; & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-server.ps1') | Out-Null }
        'client' { & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-client.ps1') | Out-Null; Start-Sleep -Seconds 1; & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-client.ps1') | Out-Null }
    }
}

function Stop-All {
    Push-Log "[launcher] 全部停止 ..."
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-client.ps1') 2>&1 | ForEach-Object { Push-Log "[stop-client] $_" }
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-server.ps1') 2>&1 | ForEach-Object { Push-Log "[stop-server] $_" }
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/stop-qdrant.ps1') 2>&1 | ForEach-Object { Push-Log "[stop-qdrant] $_" }
}

function Start-All {
    Push-Log "[launcher] 启动 qdrant ..."
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-qdrant.ps1') -Wait 2>&1 | ForEach-Object { Push-Log "[qdrant] $_" }
    Push-Log "[launcher] 启动 server ..."
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-server.ps1') 2>&1 | ForEach-Object { Push-Log "[server] $_" }
    Push-Log "[launcher] 启动 client ..."
    & pwsh -File (Join-Path $global:RepoRoot 'scripts/start-client.ps1') 2>&1 | ForEach-Object { Push-Log "[client] $_" }
    Push-Log "[launcher] 全部就绪。浏览器: http://localhost:5173"
}







