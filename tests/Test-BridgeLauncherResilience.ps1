$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $repository ".research\launcher-resilience-build"
[IO.Directory]::CreateDirectory($buildDirectory) | Out-Null

$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "The .NET Framework C# compiler was not found."
}

$launcherDirectory = Join-Path $repository "bridge\TrainerDeckBridgeLauncher"
$sharedDirectory = Join-Path $repository "bridge\Shared"
$sources = @(
    Get-ChildItem -LiteralPath $launcherDirectory -Filter "*.cs" |
        ForEach-Object FullName
)
$sources += @(
    Get-ChildItem -LiteralPath $sharedDirectory -Filter "*.cs" |
        ForEach-Object FullName
)
$assemblyPath = Join-Path $buildDirectory "TrainerDeckBridgeLauncher.exe"
$cecilPath = Join-Path $repository "bin\bridge\Mono.Cecil.dll"

& $compiler `
    /nologo `
    /target:winexe `
    /out:$assemblyPath `
    /reference:$cecilPath `
    $sources
if ($LASTEXITCODE -ne 0) {
    throw "Launcher compilation failed with exit code $LASTEXITCODE."
}

$programSource = Get-Content `
    -LiteralPath (Join-Path $launcherDirectory "Program.cs") `
    -Raw
$launcherLogSource = Get-Content `
    -LiteralPath (Join-Path $launcherDirectory "LauncherLog.cs") `
    -Raw
$launcherProject = Get-Content `
    -LiteralPath (Join-Path $launcherDirectory "TrainerDeckBridgeLauncher.csproj") `
    -Raw
if (-not $launcherProject.Contains("<TargetFramework>net462</TargetFramework>")) {
    throw "Launcher must target the single current .NET Framework 4.6.2 runtime."
}
if (-not $launcherProject.Contains("ReferenceAssemblies.net462")) {
    throw "Launcher net462 reference assemblies are not pinned."
}
if (-not $launcherProject.Contains("Shared\JsonCodec.cs")) {
    throw "Launcher lost the CLR-compatible shared JSON codec."
}
if (Test-Path -LiteralPath (Join-Path $launcherDirectory "App.config")) {
    throw "Legacy CLR activation config must not be shipped."
}
foreach ($marker in @(
    "Launcher entered:",
    "Manifest loaded:",
    "Prepared trainer available:",
    "Process.Start requested:",
    "Launcher failed before completion:"
)) {
    if (-not $programSource.Contains($marker)) {
        throw "Launcher diagnostic marker is missing: $marker"
    }
}
if ($programSource.Contains("ShortExitThresholdMilliseconds")) {
    throw "Launcher must not suppress a no-ready startup exit by lifetime."
}
foreach ($marker in @(
    "Console.Error.WriteLine",
    "Environment.SpecialFolder.LocalApplicationData",
    "trainerdeck-bridge-launcher.log"
)) {
    if (-not $launcherLogSource.Contains($marker)) {
        throw "Launcher log fallback is missing: $marker"
    }
}

$assembly = [Reflection.Assembly]::LoadFile($assemblyPath)
$programType = $assembly.GetType(
    "TrainerDeckBridgeLauncher.Program",
    $true)
$staticFlags = [Reflection.BindingFlags]::Static -bor `
    [Reflection.BindingFlags]::NonPublic
$decision = $programType.GetMethod("ShouldFailOpen", $staticFlags)
if ($null -eq $decision) {
    throw "ShouldFailOpen was not found."
}

$preparerType = $assembly.GetType(
    "TrainerDeckBridgeLauncher.TrainerPreparer",
    $true)
$clearCacheAttributes = $preparerType.GetMethod(
    "ClearCacheFileOverwriteAttributes",
    $staticFlags)
if ($null -eq $clearCacheAttributes) {
    throw "ClearCacheFileOverwriteAttributes was not found."
}
$attributeProbe = Join-Path $buildDirectory "hidden-readonly-cache-target.bin"
if ([IO.File]::Exists($attributeProbe)) {
    [IO.File]::SetAttributes($attributeProbe, [IO.FileAttributes]::Normal)
}
[IO.File]::WriteAllText($attributeProbe, "old cache payload")
[IO.File]::SetAttributes(
    $attributeProbe,
    [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReadOnly)
$clearCacheAttributes.Invoke(
    $null,
    [object[]]@([string]$attributeProbe)) | Out-Null
$remainingAttributes = [IO.File]::GetAttributes($attributeProbe)
if (($remainingAttributes -band [IO.FileAttributes]::Hidden) -ne 0 `
    -or ($remainingAttributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
    throw "Cache overwrite-blocking attributes were not cleared."
}
$clearCacheAttributes.Invoke(
    $null,
    [object[]]@([string](
        Join-Path $buildDirectory "missing-cache-target.bin"))) | Out-Null

$decisionCases = @(
    @($true, $false, $true),
    @($true, $true, $false),
    @($false, $false, $false),
    @($false, $true, $false)
)
foreach ($case in $decisionCases) {
    $actual = [bool]$decision.Invoke(
        $null,
        @([bool]$case[0], [bool]$case[1]))
    if ($actual -ne [bool]$case[2]) {
        throw (
            "Unexpected fail-open result: exited={0}, ready={1}, " +
            "actual={2}." -f
            $case[0],
            $case[1],
            $actual)
    }
}

$cacheDirectory = Join-Path $buildDirectory "probe-cache"
$originalDirectory = Join-Path $buildDirectory "probe-original"
[IO.Directory]::CreateDirectory($cacheDirectory) | Out-Null
[IO.Directory]::CreateDirectory($originalDirectory) | Out-Null
$cacheLog = Join-Path $cacheDirectory "trainerdeck-bridge.log"
$originalLog = Join-Path $originalDirectory "trainerdeck-bridge.log"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($cacheLog, "stale Bridge started.`r`n", $utf8)
[IO.File]::WriteAllText($originalLog, "stale Bridge started.`r`n", $utf8)

$probeType = $assembly.GetType(
    "TrainerDeckBridgeLauncher.Program+BridgeReadyProbe",
    $true)
$instanceFlags = [Reflection.BindingFlags]::Instance -bor `
    [Reflection.BindingFlags]::Public -bor `
    [Reflection.BindingFlags]::NonPublic
$constructor = $probeType.GetConstructors($instanceFlags)[0]
$probe = $constructor.Invoke(
    [object[]]@(,[string[]]@($cacheDirectory, $originalDirectory)))
$findReady = $probeType.GetMethod("TryFindFreshReady", $instanceFlags)

$invokeArguments = [object[]]@($null)
if ([bool]$findReady.Invoke($probe, $invokeArguments)) {
    throw "A stale bridge-ready log line was accepted as fresh."
}

[IO.File]::AppendAllText(
    $originalLog,
    "fresh Bridge started.`r`n",
    $utf8)
$invokeArguments = [object[]]@($null)
if (-not [bool]$findReady.Invoke($probe, $invokeArguments)) {
    throw "Fresh bridge-ready growth in the original directory was missed."
}
if ([string]$invokeArguments[0] -ne $originalLog) {
    throw "The original-directory ready path was not reported."
}

$probe = $constructor.Invoke(
    [object[]]@(,[string[]]@($cacheDirectory, $originalDirectory)))
[IO.File]::AppendAllText(
    $cacheLog,
    "fresh Bridge started.`r`n",
    $utf8)
$invokeArguments = [object[]]@($null)
if (-not [bool]$findReady.Invoke($probe, $invokeArguments)) {
    throw "Fresh bridge-ready growth in the cache directory was missed."
}
if ([string]$invokeArguments[0] -ne $cacheLog) {
    throw "The cache-directory ready path was not reported."
}

Write-Output (
    "PASS launcher compile, diagnostics, cache attributes, fail-open truth table, and fresh-log probes")
