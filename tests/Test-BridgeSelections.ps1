param([string]$UiAssembly = '', [string]$ChineseMenu = '', [string]$EnglishMenu = '')
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repository '.research\selection-tests'
New-Item -ItemType Directory -Path $build -Force | Out-Null
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$harness = Join-Path $build 'BridgeSelectionHarness.exe'
& (Join-Path $framework 'csc.exe') /nologo /target:exe ('/out:' + $harness) /reference:System.Xaml.dll ('/reference:' + (Join-Path $framework 'WPF\PresentationFramework.dll')) ('/reference:' + (Join-Path $framework 'WPF\PresentationCore.dll')) ('/reference:' + (Join-Path $framework 'WPF\WindowsBase.dll')) (Join-Path $PSScriptRoot 'BridgeSelectionHarness.cs')
if ($LASTEXITCODE -ne 0) { throw 'Selection harness compilation failed' }
$arguments = @((Join-Path $repository 'bin\bridge\TrainerDeckBridge.Clr4.dll'))
if ($UiAssembly) { $arguments += @($UiAssembly, $ChineseMenu, $EnglishMenu) }
& $harness @arguments
if ($LASTEXITCODE -ne 0) { throw 'Selection harness failed' }
