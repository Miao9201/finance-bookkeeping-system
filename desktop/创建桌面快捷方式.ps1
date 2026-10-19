$ErrorActionPreference='Stop'
$taskExe=Join-Path $PSScriptRoot '财务代账系统.exe'
if(!(Test-Path -LiteralPath $taskExe)){throw '未找到同目录的财务代账系统.exe'}
$taskDesktop=[Environment]::GetFolderPath('Desktop')
$taskLink=Join-Path $taskDesktop '财务代账系统.lnk'
$taskShell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $taskLink){$taskExisting=$taskShell.CreateShortcut($taskLink);if($taskExisting.TargetPath -ne $taskExe){$taskLink=Join-Path $taskDesktop '财务代账系统（备用）.lnk';if(Test-Path -LiteralPath $taskLink){throw '同名快捷方式已存在且未确认属于本程序，已保留原文件'}}}
$taskShortcut=$taskShell.CreateShortcut($taskLink)
$taskShortcut.TargetPath=$taskExe
$taskShortcut.WorkingDirectory=$PSScriptRoot
$taskShortcut.IconLocation=$taskExe+',0'
$taskIcon=Join-Path $PSScriptRoot '财务代账系统.ico'
if(Test-Path -LiteralPath $taskIcon){$taskShortcut.IconLocation=$taskIcon}
$taskShortcut.Description='财务代账系统 · 本机客户、代账业务与账务管理'
$taskShortcut.WindowStyle=1
$taskShortcut.Save()
Write-Output $taskLink
