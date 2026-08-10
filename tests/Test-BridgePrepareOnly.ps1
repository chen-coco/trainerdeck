$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
$sample = Join-Path $repository (
    ".research\sifu-ba14eff05ba3a741\" +
    "Sifu v1.5-v1.27 Plus 14 Trainer.exe")
$bridgeArtifacts = Join-Path $repository "bin\bridge"
$temporaryParent = [System.IO.Path]::GetFullPath(
    [System.IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryParent (
    "TrainerDeck-prepare-" + [Guid]::NewGuid().ToString("N"))

try {
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $trainer = Join-Path $temporary "Trainer.exe"
    Copy-Item -LiteralPath $sample -Destination $trainer
    foreach ($name in @(
        "TrainerDeckBridgeLauncher.exe",
        "TrainerDeckBridge.dll",
        "Mono.Cecil.dll"
    )) {
        Copy-Item -LiteralPath (Join-Path $bridgeArtifacts $name) `
            -Destination (Join-Path $temporary $name)
    }

    $hashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $trainer).Hash
    $manifest = [ordered]@{
        protocol = 1
        install_id = "trainerdeck-0.6.7"
        bridge_version = "0.6.7"
        host = "127.0.0.1"
        port = 37123
        token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        app_id = 2072450
        trainer_sha256 = $hashBefore.ToLowerInvariant()
        trainer_relative = "Trainer.exe"
        cacheDirectory = ".trainerdeck-cache"
        cache_relative = ".trainerdeck-cache"
        generated_at = 1785772800
        pollIntervalMs = 250
        connectTimeoutMs = 3000
        maxFrameBytes = 1048576
        resourceType = "UI"
        resourceId = 101
        resourceLanguage = 0
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText(
        (Join-Path $temporary "trainerdeck-bridge.json"),
        $manifestJson,
        (New-Object System.Text.UTF8Encoding($false)))

    $process = Start-Process `
        -FilePath (Join-Path $temporary "TrainerDeckBridgeLauncher.exe") `
        -ArgumentList "--prepare-only" `
        -WorkingDirectory $temporary `
        -WindowStyle Hidden `
        -Wait `
        -PassThru
    if ($process.ExitCode -ne 0) {
        throw "prepare-only failed with exit code $($process.ExitCode)"
    }

    $hashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $trainer).Hash
    if ($hashAfter -ne $hashBefore) {
        throw "prepare-only modified the original trainer"
    }
    $cache = Join-Path $temporary (
        ".trainerdeck-cache\" + $hashBefore.Substring(0, 16).ToLowerInvariant())
    foreach ($name in @(
        "Trainer.exe",
        "TrainerDeckBridge.dll",
        "trainerdeck-bridge.json"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $cache $name))) {
            throw "prepare-only output is missing: $name"
        }
    }
    Write-Output "PASS prepare-only patches a cache copy and preserves the original"
}
finally {
    $resolvedTemporary = [System.IO.Path]::GetFullPath($temporary)
    if (
        $resolvedTemporary.StartsWith(
            $temporaryParent,
            [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedTemporary).StartsWith(
            "TrainerDeck-prepare-",
            [System.StringComparison]::Ordinal)
    ) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}
