$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$launcherDirectory = Join-Path $repository "bridge\TrainerDeckBridgeLauncher"
$bridgeProject = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $repository "bridge\TrainerDeckBridge\TrainerDeckBridge.csproj")
$launcherProject = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $launcherDirectory "TrainerDeckBridgeLauncher.csproj")
$preparer = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $launcherDirectory "TrainerPreparer.cs")
$patcher = Get-Content -Raw -Encoding UTF8 -LiteralPath (
    Join-Path $launcherDirectory "UiAssemblyPatcher.cs")

foreach ($marker in @(
    "<TargetFrameworks>net35;net40</TargetFrameworks>",
    "Microsoft.NETFramework.ReferenceAssemblies.net35",
    "Microsoft.NETFramework.ReferenceAssemblies.net40"
)) {
    if (-not $bridgeProject.Contains($marker)) {
        throw "Dual-runtime Bridge project marker is missing: $marker"
    }
}
if (($launcherProject.Split("<EmbeddedResource").Length - 1) -ne 2) {
    throw "The Host must embed exactly two Bridge payload build outputs."
}
$normalizedLauncherProject = $launcherProject.Replace("\", "/")
foreach ($marker in @(
    "net35/TrainerDeckBridge.dll",
    "net40/TrainerDeckBridge.dll",
    'ReferenceOutputAssembly="false"'
)) {
    if (-not $normalizedLauncherProject.Contains($marker)) {
        throw "Embedded Host project marker is missing: $marker"
    }
}

foreach ($marker in @(
    'BridgeFileName = "TrainerDeckBridge.dll"',
    "UiAssemblyPatcher.InspectRuntime",
    "ReadEmbeddedBridgePayload",
    "GetManifestResourceStream",
    "File.WriteAllBytes",
    "ResolveCacheRoot",
    "manifest.cacheDirectory",
    "TryHide(cacheDirectory)",
    "ClearCacheFileOverwriteAttributes"
)) {
    if (-not $preparer.Contains($marker)) {
        throw "Embedded payload preparation marker is missing: $marker"
    }
}
foreach ($forbidden in @(
    "bridgeAssemblyPath",
    'File.Copy(bridgeAssemblyPath'
)) {
    if ($preparer.Contains($forbidden)) {
        throw "External Bridge payload dependency remains: $forbidden"
    }
}

foreach ($marker in @(
    "BridgeRuntime.Clr2",
    "BridgeRuntime.Clr4",
    "mscorlibMajor == 2",
    "mscorlibMajor == 4",
    "metadataRuntime != coreLibraryRuntime",
    "EnsureExpectedRuntime",
    "AddExitTrampoline",
    "AddStateCallbacks",
    "AddMenuPayloadCallback"
)) {
    if (-not $patcher.Contains($marker)) {
        throw "Dual-runtime patcher marker is missing: $marker"
    }
}
if ($patcher.Contains("major != 2")) {
    throw "The patcher still rejects every CLR generation except CLR2."
}

Write-Output (
    "PASS embedded Host selects CLR2/CLR4 and publishes one canonical cache DLL")
