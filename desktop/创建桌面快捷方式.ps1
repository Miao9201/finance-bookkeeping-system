$ErrorActionPreference='Stop'
$taskExe=Join-Path $PSScriptRoot '云代账.exe'
if(!(Test-Path -LiteralPath $taskExe)){throw '未找到同目录的云代账.exe'}
$taskDesktop=[Environment]::GetFolderPath('Desktop')
$taskLink=Join-Path $taskDesktop '云代账.lnk'
$taskShell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $taskLink){$taskExisting=$taskShell.CreateShortcut($taskLink);if($taskExisting.TargetPath -ne $taskExe){$taskLink=Join-Path $taskDesktop '云代账本地版.lnk';if(Test-Path -LiteralPath $taskLink){throw '同名快捷方式已存在且未确认属于本程序，已保留原文件'}}}
$taskShortcut=$taskShell.CreateShortcut($taskLink)
$taskShortcut.TargetPath=$taskExe
$taskShortcut.WorkingDirectory=$PSScriptRoot
$taskShortcut.IconLocation=$taskExe+',0'
$taskShortcut.Description='云代账本地版 · 本机客户、代账业务与账务管理'
$taskShortcut.WindowStyle=1
$taskShortcut.Save()
Write-Output $taskLink
