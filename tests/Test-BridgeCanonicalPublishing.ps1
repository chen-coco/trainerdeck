$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
$launcherDirectory = Join-Path $repository "bridge\TrainerDeckBridgeLauncher"
$preparer = Get-Content -Raw -LiteralPath (
    Join-Path $launcherDirectory "TrainerPreparer.cs")
$patcher = Get-Content -Raw -LiteralPath (
    Join-Path $launcherDirectory "UiAssemblyPatcher.cs")

foreach ($obsolete in @(
    "BridgeAssemblySelector.cs",
    "AtomicBridgePublisher.cs",
    "App.config"
)) {
    if (Test-Path -LiteralPath (Join-Path $launcherDirectory $obsolete)) {
        throw "Obsolete multi-runtime source remains: $obsolete"
    }
}

foreach ($marker in @(
    'BridgeFileName = "TrainerDeckBridge.dll"',
    "ResolveCacheRoot",
    "manifest.cacheDirectory",
    "TryHide(cacheDirectory)",
    "ClearCacheFileOverwriteAttributes(preparedPath)",
    "ClearCacheFileOverwriteAttributes(cachedBridgePath)",
    "ClearCacheFileOverwriteAttributes(cachedManifestPath)",
    "File.Copy(stagingPath, preparedPath, true)",
    "UiAssemblyPatcher.InjectBridgeStart"
)) {
    if (-not $preparer.Contains($marker)) {
        throw "0.5.1 preparation/safety marker is missing: $marker"
    }
}
foreach ($forbidden in @(
    "TrainerDeckBridge.Legacy.dll",
    "BridgeAssemblySelector",
    "AtomicBridgePublisher"
)) {
    if ($preparer.Contains($forbidden)) {
        throw "Multi-runtime behavior remains: $forbidden"
    }
}
foreach ($marker in @(
    "EnsureCurrentRuntime",
    "major != 2",
    "AddExitTrampoline",
    "AddStateCallbacks",
    "AddMenuPayloadCallback"
)) {
    if (-not $patcher.Contains($marker)) {
        throw "Fixed CLR2 bridge safety/hook marker is missing: $marker"
    }
}
if ($patcher.Contains("BridgeAssemblySelector")) {
    throw "UI patcher still delegates runtime selection."
}

Write-Output (
    "PASS single net35 bridge with 0.5.1 cache safety and three hooks")
