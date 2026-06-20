# AI-Novel Launcher 入口 - 加载 lib + 主交互循环
# 用法:
#   pwsh -File scripts/launcher.ps1            # 自动拉起所有服务并进入交互
#   pwsh -File scripts/launcher.ps1 -OnlyRun   # 只启动,不进入交互(保留旧行为名)
#
# 顶部 4 行:server / client / qdrant / llm 实时状态
# 中部菜单:R / 1 / 2 / 3 / O / L / C / H / Q
# 下部日志流:每个服务按时间顺序 tail(默认 30 行)

. (Join-Path $PSScriptRoot 'launcher/lib.ps1')

$autoStart = -not ($args -contains '-OnlyRun')

if ($autoStart) {
    Start-All
}

Push-Log "[launcher] 进入交互循环。按 H 看帮助,Q 退出。"

while (-not $global:ShouldExit) {
    Refresh-LogStreams
    Render

    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        switch ($key.KeyChar.ToString().ToLower()) {
            'q' { $global:ShouldExit = $true }
            'r' { Restart-Service 'qdrant'; Restart-Service 'server'; Restart-Service 'client' }
            '1' { Restart-Service 'server' }
            '2' { Restart-Service 'client' }
            '3' { Restart-Service 'qdrant' }
            'o' {
                Push-Log "[launcher] 打开浏览器 ..."
                Start-Process 'http://localhost:5173' | Out-Null
            }
            'l' {
                $global:LlmEnabled = -not $global:LlmEnabled
                Push-Log "[launcher] LLM 栏 $($global:LlmEnabled)"
            }
            'c' { $global:LogBuffer.Clear() }
            'h' { Show-Help }
        }
    }

    Start-Sleep -Milliseconds 500
}

Stop-All
Write-Host ""
Write-Host "[launcher] 再见。" -ForegroundColor Cyan
