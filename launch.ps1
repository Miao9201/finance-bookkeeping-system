param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:3210'
try {
    $existing = $null
    try { $existing = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 2 } catch {}
    if ($existing -and $existing.code -eq 0 -and $existing.data.system.mode -eq '本机单人模式') {
        Write-Host "财务代账系统已在运行：$appUrl"
        if (!$NoBrowser) { Start-Process $appUrl }
        exit 0
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (!$nodeCommand) { throw '未找到 Node.js。请安装 Node.js 24 LTS 后重新打开本程序。' }
    $nodePath = $nodeCommand.Source
    $nodeMajor = [int](([string](& $nodePath --version)).TrimStart('v').Split('.')[0])
    if ($nodeMajor -lt 24) { throw '需要 Node.js 24 或更新版本。' }
    if (!(Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\express\package.json'))) {
        $npmPath = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
        if (!(Test-Path -LiteralPath $npmPath)) { throw '未找到 npm.cmd，请完整安装 Node.js 24。' }
        Write-Host '首次运行：正在安装本地运行依赖…'
        Push-Location $appRoot
        try { & $npmPath ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络后重试。' } } finally { Pop-Location }
    }
    if (!(Test-Path -LiteralPath (Join-Path $appRoot 'dist\index.html'))) { throw '缺少已构建界面，请在工程目录运行 npm install 和 npm run build。' }
    $taskData = Join-Path $appRoot 'data'
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
    $env:PORT = '3210'
    $env:YUNDAIZHANG_DATA_DIR = $taskData
    $entry = Join-Path $appRoot 'server\index.js'
    $appProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'server.log') -RedirectStandardError (Join-Path $taskData 'server-error.log') -PassThru
    Set-Content -LiteralPath (Join-Path $taskData 'server.pid') -Value $appProcess.Id -Encoding Ascii
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($appProcess.HasExited) { throw ('服务启动失败：' + (Get-Content -LiteralPath (Join-Path $taskData 'server-error.log') -Raw)) }
        try { $stateResult = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 1; if ($stateResult.code -eq 0 -and $stateResult.data.system.mode -eq '本机单人模式') { $ready = $true; break } } catch {}
    }
    if (!$ready) { throw '本地服务没有及时响应，请查看 data\server-error.log。' }
    Write-Host "财务代账系统已启动：$appUrl"
    Write-Host "数据目录：$taskData"
    Write-Host '关闭浏览器后服务仍在本机运行。需要停止时请双击“停止财务代账系统.cmd”。'
    if (!$NoBrowser) { Start-Process $appUrl }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
