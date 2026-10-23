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
# Render the supplied artwork through a rounded mask; keep the source image unchanged.
$taskImage=[System.Drawing.Image]::FromFile((Join-Path $taskApp 'src\assets\app-icon.png'))
$taskMaster=New-Object System.Drawing.Bitmap(1024,1024)
$taskGraphics=[System.Drawing.Graphics]::FromImage($taskMaster)
$taskGraphics.Clear([System.Drawing.Color]::Transparent)
$taskGraphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$taskShape=New-Object System.Drawing.Drawing2D.GraphicsPath
$taskDiameter=[single](1024*0.36)
$taskEdge=[single](1024-$taskDiameter)
$taskShape.AddArc(0,0,$taskDiameter,$taskDiameter,180,90)
$taskShape.AddArc($taskEdge,0,$taskDiameter,$taskDiameter,270,90)
$taskShape.AddArc($taskEdge,$taskEdge,$taskDiameter,$taskDiameter,0,90)
$taskShape.AddArc(0,$taskEdge,$taskDiameter,$taskDiameter,90,90)
$taskShape.CloseFigure()
$taskGraphics.SetClip($taskShape)
$taskGraphics.DrawImage($taskImage,0,0,1024,1024)
$taskSizes=@(16,24,32,48,64,128,256)
$taskFrames=@()
foreach($taskSize in $taskSizes){
 $taskBitmap=New-Object System.Drawing.Bitmap($taskSize,$taskSize)
 $taskResize=[System.Drawing.Graphics]::FromImage($taskBitmap)
 $taskResize.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
 $taskResize.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
 $taskResize.DrawImage($taskMaster,0,0,$taskSize,$taskSize)
 $taskPng=New-Object System.IO.MemoryStream
 $taskBitmap.Save($taskPng,[System.Drawing.Imaging.ImageFormat]::Png)
 $taskFrames+=,@($taskSize,$taskPng.ToArray())
 if($taskSize -eq 256){$taskBitmap.Save((Join-Path $taskBuild 'app-icon-preview.png'),[System.Drawing.Imaging.ImageFormat]::Png)}
 $taskPng.Dispose();$taskResize.Dispose();$taskBitmap.Dispose()
}
$taskWriter=New-Object System.IO.BinaryWriter([System.IO.File]::Create((Join-Path $taskBuild 'app.ico')))
try{
 $taskWriter.Write([uint16]0);$taskWriter.Write([uint16]1);$taskWriter.Write([uint16]$taskFrames.Count)
 $taskOffset=6+16*$taskFrames.Count
 foreach($taskFrame in $taskFrames){
  $taskDimension=[byte]($taskFrame[0] % 256)
  $taskWriter.Write($taskDimension);$taskWriter.Write($taskDimension);$taskWriter.Write([uint16]0)
  $taskWriter.Write([uint16]1);$taskWriter.Write([uint16]32)
  $taskWriter.Write([uint32]$taskFrame[1].Length);$taskWriter.Write([uint32]$taskOffset)
  $taskOffset+=$taskFrame[1].Length
 }
 foreach($taskFrame in $taskFrames){$taskWriter.Write([byte[]]$taskFrame[1])}
}finally{$taskWriter.Dispose();$taskGraphics.Dispose();$taskShape.Dispose();$taskMaster.Dispose();$taskImage.Dispose()}
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskRefs=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll',(Join-Path $SdkDirectory 'lib\net462\Microsoft.Web.WebView2.Core.dll'),(Join-Path $SdkDirectory 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))
$taskArgs=@('/nologo','/target:winexe','/platform:x64','/optimize+',('/out:'+(Join-Path $taskOutput '财务代账系统.exe')),('/win32manifest:'+(Join-Path $taskSource 'app.manifest')),('/win32icon:'+(Join-Path $taskBuild 'app.ico')),('/resource:'+(Join-Path $taskBuild 'payload.zip')+',payload.zip'),('/resource:'+(Join-Path $taskBuild 'payload.sha256')+',payload.sha256'))
foreach ($taskRef in $taskRefs) { $taskArgs+=('/reference:'+$taskRef) }
$taskArgs+=(Join-Path $taskSource 'Main.cs');$taskArgs+=(Join-Path $taskSource 'DesktopWindow.cs')
& $taskCompiler @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Desktop EXE compilation failed' }
Copy-Item -LiteralPath (Join-Path $taskBuild 'app.ico') -Destination (Join-Path $taskOutput '财务代账系统.ico')
Copy-Item -LiteralPath (Join-Path $taskSource '创建桌面快捷方式.ps1') -Destination $taskOutput
foreach ($taskDoc in @('LICENSE','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $taskApp $taskDoc) -Destination $taskOutput }
Copy-Item -LiteralPath (Join-Path $taskApp 'docs\使用说明.md') -Destination $taskOutput
$taskExePath=Join-Path $taskOutput '财务代账系统.exe'
$taskHasher=[System.Security.Cryptography.SHA256]::Create()
$taskStream=[System.IO.File]::OpenRead($taskExePath)
try { $taskDigest=[BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() }
finally { $taskStream.Dispose();$taskHasher.Dispose() }
Write-Output ("EXE_READY " + $taskDigest + '  ' + $taskExePath)
