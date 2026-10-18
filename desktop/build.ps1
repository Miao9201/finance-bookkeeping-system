param([string]$SdkDirectory)
$ErrorActionPreference='Stop'
$taskSource=$PSScriptRoot
$taskApp=Split-Path -Parent $taskSource
$taskArtifacts=Join-Path $taskApp 'artifacts'
if (!$SdkDirectory) { $SdkDirectory=Join-Path $taskArtifacts 'webview2\sdk' }
$taskBuild=Join-Path $taskArtifacts 'desktop-build'
$taskOutput=Join-Path $taskApp 'release'
New-Item -ItemType Directory -Force -Path $taskBuild,$taskOutput | Out-Null
$taskNode=(Get-Command node.exe).Source
$taskNodeVersion=(& $taskNode --version).Trim()
if ($taskNodeVersion -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or later is required' }
if ((& $taskNode -p process.platform) -ne 'win32' -or (& $taskNode -p process.arch) -ne 'x64') { throw 'Use Windows x64 Node.js' }
& python (Join-Path $taskSource 'fetch-build-deps.py') --sdk $SdkDirectory --out $taskBuild --node-version $taskNodeVersion
if ($LASTEXITCODE -ne 0) { throw 'Official build dependency download failed' }
$taskNodeLicense=Join-Path $taskBuild 'Node-LICENSE.txt'
Push-Location $taskApp
try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' } } finally { Pop-Location }
& python (Join-Path $taskSource 'build-payload.py') --app $taskApp --sdk $SdkDirectory --node $taskNode --out $taskBuild --node-license $taskNodeLicense
if ($LASTEXITCODE -ne 0) { throw 'Payload packaging failed' }
Add-Type -AssemblyName System.Drawing
$taskBitmap=New-Object System.Drawing.Bitmap(128,128)
$taskGraphics=[System.Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskGraphics.Clear([System.Drawing.Color]::Transparent)
$taskBlue=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36,104,237))
$taskWhite=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$taskGraphics.FillEllipse($taskBlue,2,2,124,124)
$taskGraphics.FillEllipse($taskWhite,22,53,40,35)
$taskGraphics.FillEllipse($taskWhite,38,32,51,52)
$taskGraphics.FillEllipse($taskWhite,70,48,39,40)
$taskGraphics.FillRectangle($taskWhite,40,60,48,28)
$taskPen=New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(36,104,237),7)
$taskPen.StartCap=[System.Drawing.Drawing2D.LineCap]::Round;$taskPen.EndCap=[System.Drawing.Drawing2D.LineCap]::Round
$taskGraphics.DrawLines($taskPen,[System.Drawing.Point[]]@((New-Object System.Drawing.Point(45,64)),(New-Object System.Drawing.Point(58,77)),(New-Object System.Drawing.Point(84,50))))
$taskIcon=[System.Drawing.Icon]::FromHandle($taskBitmap.GetHicon())
$taskIconStream=[System.IO.File]::Create((Join-Path $taskBuild 'app.ico'))
$taskIcon.Save($taskIconStream);$taskIconStream.Dispose();$taskIcon.Dispose();$taskGraphics.Dispose();$taskBitmap.Dispose();$taskPen.Dispose();$taskBlue.Dispose();$taskWhite.Dispose()
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskRefs=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll',(Join-Path $SdkDirectory 'lib\net462\Microsoft.Web.WebView2.Core.dll'),(Join-Path $SdkDirectory 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))
$taskArgs=@('/nologo','/target:winexe','/platform:x64','/optimize+',('/out:'+(Join-Path $taskOutput '云代账.exe')),('/win32manifest:'+(Join-Path $taskSource 'app.manifest')),('/win32icon:'+(Join-Path $taskBuild 'app.ico')),('/resource:'+(Join-Path $taskBuild 'payload.zip')+',payload.zip'),('/resource:'+(Join-Path $taskBuild 'payload.sha256')+',payload.sha256'))
foreach ($taskRef in $taskRefs) { $taskArgs+=('/reference:'+$taskRef) }
$taskArgs+=(Join-Path $taskSource 'Main.cs');$taskArgs+=(Join-Path $taskSource 'DesktopWindow.cs')
& $taskCompiler @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Desktop EXE compilation failed' }
Copy-Item -LiteralPath (Join-Path $taskSource '创建桌面快捷方式.ps1') -Destination $taskOutput
foreach ($taskDoc in @('LICENSE','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $taskApp $taskDoc) -Destination $taskOutput }
Copy-Item -LiteralPath (Join-Path $taskApp 'docs\使用说明.md') -Destination $taskOutput
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $taskOutput '云代账.exe') | Format-List Path,Hash
