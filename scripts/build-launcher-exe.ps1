# 打包 tools/launcher_gui.py 成单文件 .exe,产物直接放在仓库根目录(跟 MuMuAINovel.exe 同款位置)
# 产物: ./AI-Novel-Launcher.exe
# 依赖: psutil(launcher 用)+ pyinstaller(打包用)
# 用法:
#   pwsh -File scripts/build-launcher-exe.ps1
#   pwsh -File scripts/build-launcher-exe.ps1 -Clean    # 先清旧 exe + build 目录
#   pwsh -File scripts/build-launcher-exe.ps1 -SkipDeps # 假设依赖已装

[CmdletBinding()]
param(
    [switch]$SkipDeps,
    [switch]$Clean
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$toolsDir = Join-Path $repoRoot 'tools'
$workDir = Join-Path $toolsDir 'launcher-build'
$iconPath = Join-Path $repoRoot 'client/public/favicon.ico'
$scriptPath = Join-Path $toolsDir 'launcher_gui.py'
$exePath = Join-Path $repoRoot 'AI-Novel-Launcher.exe'

if (-not (Test-Path $scriptPath)) {
    throw "找不到 launcher 源码: $scriptPath"
}

# 1. 装依赖
if (-not $SkipDeps) {
    Write-Output "[build] 检查 Python 依赖 ..."
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $py) { throw "找不到 python,请先装 Python 3.10+" }

    & python -c "import psutil" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[build] 装 psutil ..."
        & python -m pip install --quiet psutil
    } else {
        Write-Output "[build] psutil 已装"
    }

    & pyinstaller --version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "[build] 装 pyinstaller ..."
        & python -m pip install --quiet pyinstaller
    } else {
        Write-Output "[build] pyinstaller 已装"
    }
}

# 2. 清旧产物(只清 .exe 和 build 目录,绝对不能碰 $repoRoot)
if ($Clean -or (Test-Path $exePath)) {
    Write-Output "[build] 删旧 .exe: $exePath"
    Remove-Item -Force $exePath -ErrorAction SilentlyContinue
}
if (Test-Path $workDir) {
    Write-Output "[build] 删旧 build 目录: $workDir"
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

# 3. 跑 PyInstaller
Write-Output "[build] 打包中(单文件 + 隐藏控制台)..."
$iconArg = @()
if (Test-Path $iconPath) { $iconArg = @('--icon', $iconPath) } else { Write-Warning "图标不存在,会无图标打包" }

$pyiArgs = @(
    '--onefile'
    '--windowed'
    '--name', 'AI-Novel-Launcher'
    '--distpath', $repoRoot
    '--workpath', $workDir
    '--specpath', $workDir
    '--clean'
) + $iconArg + @($scriptPath)

$proc = Start-Process -FilePath 'pyinstaller' -ArgumentList $pyiArgs -WorkingDirectory $repoRoot -NoNewWindow -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "PyInstaller 失败,exit code $($proc.ExitCode)"
}

# 4. 验证
if (-not (Test-Path $exePath)) {
    throw "产物未生成: $exePath"
}
$size = (Get-Item $exePath).Length
Write-Output ""
Write-Output "[build] 成功: $exePath ($([math]::Round($size / 1MB, 2)) MB)"
Write-Output "[build] 双击运行即可,中间产物 $workDir 可删"
