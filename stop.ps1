$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (!(Test-Path -LiteralPath $taskPidFile)) { Write-Host '没有本启动器记录的服务进程。若通过终端启动，请在原终端按 Ctrl+C。'; exit 0 }
$taskProcessId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
if (!$taskProcess) { Write-Host '服务已经停止。'; exit 0 }
$taskEntry = Join-Path $PSScriptRoot 'server\index.js'
if ($taskProcess.Name -ne 'node.exe' -or !$taskProcess.CommandLine.Contains($taskEntry)) { Write-Host '进程已变化，未停止其他程序。'; exit 1 }
Stop-Process -Id $taskProcessId
Write-Host '财务代账系统服务已停止，本地数据已保留。'
