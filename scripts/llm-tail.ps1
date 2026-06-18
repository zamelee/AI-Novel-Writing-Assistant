# ============================================================
# AI-Novel LLM 实时探针 — 粘到新 pwsh 窗口直接跑
# Tail .logs/YYYY-MM-DD/*.llm.jsonl,展示完整 request/response
# 用法:  pwsh -File scripts\llm-tail.ps1
#        或者整段粘到 pwsh 窗口
# 调参:  $MaxContent  控制单条 content 显示字符数(默认 600)
#        $SeedLines   启动时回看多少行历史(默认 30)
# 退出:  Ctrl+C
# ============================================================
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8

$env:PYTHONIOENCODING='utf-8'; chcp 65001 | Out-Null
$ErrorActionPreference = 'SilentlyContinue'

# 脚本位置推断仓库根(放 scripts/ 下时 Parent = 仓库根)
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$MaxContent = 600
$SeedLines  = 30

function Get-Active-Jsonl {
  $today = Join-Path $repoRoot ".logs\$(Get-Date -Format 'yyyy-MM-dd')"
  $cands = @()
  if (Test-Path $today) { $cands += @(Get-ChildItem $today -Filter *.llm.jsonl) }
  Get-ChildItem (Join-Path $repoRoot '.logs') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne (Get-Date -Format 'yyyy-MM-dd') } |
    ForEach-Object { $cands += @(Get-ChildItem $_.FullName -Filter *.llm.jsonl) }
  if (-not $cands) { return $null }
  return $cands | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Trim($s) {
  if ($null -eq $s) { return '' }
  $s = [string]$s
  if ($s.Length -gt $MaxContent) { return $s.Substring(0,$MaxContent) + "...[+$($s.Length-$MaxContent) chars]" }
  return $s
}

function Show-Event($o) {
  $bar = '═' * 72
  Write-Host $bar -ForegroundColor DarkCyan
  # log raw = UTC ISO 8601 (server 用 new Date().toISOString() 写),转本地时区显示
  $localTs = ([DateTime]$o.timestamp).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz')
  Write-Host ("[{0}] {1,-8}  {2}/{3}   task={4}   rid={5}   latency={6}ms   pTokens={7}" -f `
    $localTs, $o.event.ToUpper(), $o.provider, $o.model, $o.taskType, $o.requestId, $o.latencyMs, $o.actualPromptTokens) -ForegroundColor Cyan
  if ($o.event -eq 'request') {
    foreach ($m in $o.payload) {
      Write-Host ("    ── {0} ──" -f $m.role) -ForegroundColor Yellow
      (Trim $m.content) -split "`n" | Select-Object -First 14 | ForEach-Object { Write-Host ('    ' + $_) }
    }
    if ($o.promptMeta) {
      Write-Host ("    [meta] promptId={0} v{1} estTok={2} repair={3}/{4} sretry={5}/{6}" -f `
        $o.promptMeta.promptId, $o.promptMeta.promptVersion, $o.promptMeta.estimatedInputTokens, `
        $o.promptMeta.repairUsed, $o.promptMeta.repairAttempts, $o.promptMeta.semanticRetryUsed, $o.promptMeta.semanticRetryAttempts) -ForegroundColor DarkGray
    }
  }
  elseif ($o.event -eq 'response') {
    Write-Host '    ── content ──' -ForegroundColor Green
    (Trim $o.payload.content) -split "`n" | Select-Object -First 20 | ForEach-Object { Write-Host ('    ' + $_) }
    if ($o.usage) { Write-Host ("    usage: " + ($o.usage | ConvertTo-Json -Compress)) -ForegroundColor DarkGray }
  }
  elseif ($o.event -eq 'error') {
    Write-Host ("    ERROR: " + ($o.error | Out-String).Trim()) -ForegroundColor Red
  }
}

$f = Get-Active-Jsonl
if (-not $f) {
  Write-Host "no .llm.jsonl found under $repoRoot\.logs — 启动 server 后会自动开始" -ForegroundColor Yellow
  return
}
Write-Host ("watching: {0}   (Ctrl+C to stop, $MaxContent={1})" -f $f.FullName, $MaxContent) -ForegroundColor Magenta

# 先吐最近 $SeedLines 行历史
Get-Content $f.FullName -Tail $SeedLines -Encoding UTF8 | ForEach-Object {
  if ($_.Trim()) { try { Show-Event ($_ | ConvertFrom-Json) | Out-Null; Write-Host '' } catch {} }
}
Write-Host '--- live tail starts below ---' -ForegroundColor Magenta

# 持续 tail
$lastSize = (Get-Item $f.FullName).Length
$cur = $f
while ($true) {
  Start-Sleep -Milliseconds 800
  $next = Get-Active-Jsonl
  if (-not $next) { continue }
  if ($next.FullName -ne $cur.FullName) {
    $cur = $next; $lastSize = 0
    Write-Host ("`n[new file] {0}" -f $cur.FullName) -ForegroundColor Magenta
  }
  $now = (Get-Item $cur.FullName).Length
  if ($now -le $lastSize) { continue }
  # PS 5.1 解析器对相邻字符串字面量 ('Open','Read','ReadWrite') 误判为隐式拼接,用枚举
  $fs = [System.IO.File]::Open($cur.FullName,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite)
  try {
    $fs.Position = $lastSize
    $rdr = New-Object System.IO.StreamReader($fs,
      [System.Text.Encoding]::UTF8, $true, 4096)
    while (($line = $rdr.ReadLine()) -ne $null) {
      if (-not $line.Trim()) { continue }
      try { Show-Event ($line | ConvertFrom-Json) | Out-Null; Write-Host '' }
      catch { Write-Host ("<bad json: {0}>" -f $_.Exception.Message) -ForegroundColor Red }
    }
  } finally {
    $fs.Close()
  }
  $lastSize = $now
}