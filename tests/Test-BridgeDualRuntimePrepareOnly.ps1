$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$bridgeArtifacts = Join-Path $repository "bin\bridge"
$launcherAsset = Join-Path $bridgeArtifacts "TrainerDeckBridgeLauncher.exe"
$cecilAsset = Join-Path $bridgeArtifacts "Mono.Cecil.dll"
$uiSource = Join-Path $PSScriptRoot "SyntheticTrainerUi.cs"
$hostSource = Join-Path $PSScriptRoot "SyntheticTrainerHost.cs"
$uiProject = Join-Path $PSScriptRoot "SyntheticTrainerUi.csproj"
$hostProject = Join-Path $PSScriptRoot "SyntheticTrainerHost.csproj"
$localDotnet = Join-Path $repository ".tools\dotnet\dotnet.exe"
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary = Join-Path $temporaryParent (
    "TrainerDeck-synthetic-prepare-" + [Guid]::NewGuid().ToString("N"))

function Invoke-Dotnet([string[]]$arguments) {
    & $script:dotnetCommand $arguments
    if ($LASTEXITCODE -ne 0) {
        throw (
            "dotnet failed with exit code ${LASTEXITCODE}: " +
            ($arguments -join " "))
    }
}

function Xor-Bytes([byte[]]$source, [byte[]]$key) {
    $result = New-Object byte[] $source.Length
    for ($index = 0; $index -lt $source.Length; $index++) {
        $result[$index] = $source[$index] -bxor $key[$index % $key.Length]
    }
    return $result
}

try {
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    foreach ($required in @(
        $launcherAsset,
        $cecilAsset,
        $uiSource,
        $hostSource,
        $uiProject,
        $hostProject
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required prepare-only fixture input is missing: $required"
        }
    }

    $script:dotnetCommand = if (Test-Path -LiteralPath $localDotnet) {
        $localDotnet
    }
    else {
        (Get-Command dotnet -ErrorAction Stop).Source
    }
    $env:DOTNET_CLI_HOME = Join-Path $repository ".tools\dotnet-home"
    $env:NUGET_PACKAGES = Join-Path $repository ".tools\nuget-packages"
    $fixtureBuild = Join-Path $temporary "fixture-build"
    $fixtureUiBuild = Join-Path $fixtureBuild "ui"
    $fixtureHostBuild = Join-Path $fixtureBuild "host"
    [IO.Directory]::CreateDirectory($fixtureUiBuild) | Out-Null
    [IO.Directory]::CreateDirectory($fixtureHostBuild) | Out-Null
    Copy-Item -LiteralPath $uiSource -Destination $fixtureUiBuild
    Copy-Item -LiteralPath $uiProject -Destination $fixtureUiBuild
    Copy-Item -LiteralPath $hostSource -Destination $fixtureHostBuild
    Copy-Item -LiteralPath $hostProject -Destination $fixtureHostBuild
    $fixtureUiProject = Join-Path $fixtureUiBuild "SyntheticTrainerUi.csproj"
    $fixtureHostProject = Join-Path $fixtureHostBuild "SyntheticTrainerHost.csproj"
    Invoke-Dotnet @(
        "restore",
        $fixtureUiProject,
        "--ignore-failed-sources"
    )
    Invoke-Dotnet @(
        "restore",
        $fixtureHostProject,
        "--ignore-failed-sources"
    )
    Invoke-Dotnet @(
        "build",
        $fixtureUiProject,
        "--configuration",
        "Release",
        "--no-restore"
    )
    Invoke-Dotnet @(
        "build",
        $fixtureHostProject,
        "--configuration",
        "Release",
        "--no-restore"
    )
    $builtHost = Join-Path $fixtureHostBuild (
        "bin\Release\net462\SyntheticTrainerHost.exe")
    Add-Type -Path $cecilAsset
    $launcherAssembly = [Reflection.Assembly]::LoadFile($launcherAsset)
    $resourceType = $launcherAssembly.GetType(
        "TrainerDeckBridgeLauncher.PeUiResource",
        $true)
    $staticFlags = [Reflection.BindingFlags]::Static -bor `
        [Reflection.BindingFlags]::Public -bor `
        [Reflection.BindingFlags]::NonPublic
    $replaceResource = $resourceType.GetMethod("Replace", $staticFlags)
    if ($null -eq $replaceResource) {
        throw "The launcher's PE resource writer was not found."
    }

    $standardMzFirst32 = [byte[]]@(
        0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
        0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
        0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    )
    $cases = @(
        [ordered]@{
            Name = "clr2"
            UiAssembly = Join-Path $fixtureUiBuild (
                "bin\Release\net35\SyntheticTrainerUi.dll")
            RuntimePrefix = "v2."
            MscorlibMajor = 2
        },
        [ordered]@{
            Name = "clr4"
            UiAssembly = Join-Path $fixtureUiBuild (
                "bin\Release\net40\SyntheticTrainerUi.dll")
            RuntimePrefix = "v4."
            MscorlibMajor = 4
        }
    )

    foreach ($case in $cases) {
        $caseDirectory = Join-Path $temporary $case.Name
        [IO.Directory]::CreateDirectory($caseDirectory) | Out-Null
        $uiAssembly = Join-Path $caseDirectory "SyntheticTrainerUi.dll"
        $trainer = Join-Path $caseDirectory "SyntheticTrainer.exe"
        Copy-Item -LiteralPath $case.UiAssembly -Destination $uiAssembly
        Copy-Item -LiteralPath $builtHost -Destination $trainer

        $uiBytes = [IO.File]::ReadAllBytes($uiAssembly)
        for ($index = 0; $index -lt $standardMzFirst32.Length; $index++) {
            if ($uiBytes[$index] -ne $standardMzFirst32[$index]) {
                throw "$($case.Name) fixture does not use the standard MZ header."
            }
        }
        $xorKey = New-Object byte[] 32
        for ($index = 0; $index -lt $xorKey.Length; $index++) {
            $xorKey[$index] = [byte](17 + $index)
        }
        [byte[]]$encryptedUi = Xor-Bytes $uiBytes $xorKey
        $replaceArguments = [object[]]::new(5)
        $replaceArguments[0] = [string]$trainer
        $replaceArguments[1] = [string]"UI"
        $replaceArguments[2] = [int]101
        $replaceArguments[3] = [ushort]1033
        $replaceArguments[4] = [byte[]]$encryptedUi
        $replaceResource.Invoke($null, $replaceArguments) | Out-Null

        Copy-Item -LiteralPath $launcherAsset -Destination $caseDirectory
        Copy-Item -LiteralPath $cecilAsset -Destination $caseDirectory
        $externalPayloads = @(
            Get-ChildItem -LiteralPath $caseDirectory `
                -Filter "TrainerDeckBridge*.dll" -File
        )
        if ($externalPayloads.Count -ne 0) {
            throw "$($case.Name) fixture copied an external bridge payload."
        }

        $hashBefore = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $trainer
        ).Hash
        $manifest = [ordered]@{
            protocol = 1
            install_id = "synthetic-$($case.Name)"
            bridge_version = "synthetic"
            host = "127.0.0.1"
            port = 37123
            token = (
                "0123456789abcdef0123456789abcdef" +
                "0123456789abcdef0123456789abcdef")
            app_id = 2072450
            trainer_sha256 = $hashBefore.ToLowerInvariant()
            trainer_relative = "SyntheticTrainer.exe"
            cacheDirectory = ".trainerdeck-cache"
            cache_relative = ".trainerdeck-cache"
            generated_at = 1785772800
            pollIntervalMs = 250
            connectTimeoutMs = 3000
            maxFrameBytes = 1048576
            resourceType = "UI"
            resourceId = 101
            resourceLanguage = 1033
        }
        [IO.File]::WriteAllText(
            (Join-Path $caseDirectory "trainerdeck-bridge.json"),
            ($manifest | ConvertTo-Json -Depth 4),
            (New-Object Text.UTF8Encoding($false)))

        $standardOutput = Join-Path $caseDirectory "prepare.stdout.txt"
        $standardError = Join-Path $caseDirectory "prepare.stderr.txt"
        $process = Start-Process `
            -FilePath (Join-Path $caseDirectory "TrainerDeckBridgeLauncher.exe") `
            -ArgumentList "--prepare-only" `
            -WorkingDirectory $caseDirectory `
            -WindowStyle Hidden `
            -RedirectStandardOutput $standardOutput `
            -RedirectStandardError $standardError `
            -Wait `
            -PassThru
        if ($process.ExitCode -ne 0) {
            $diagnostic = [IO.File]::ReadAllText($standardError)
            throw (
                "$($case.Name) prepare-only failed with exit code " +
                "$($process.ExitCode): $diagnostic")
        }

        $hashAfter = (
            Get-FileHash -Algorithm SHA256 -LiteralPath $trainer
        ).Hash
        if ($hashAfter -ne $hashBefore) {
            throw "$($case.Name) prepare-only modified the original trainer."
        }
        $cacheRoot = Join-Path $caseDirectory ".trainerdeck-cache"
        $cacheCandidates = @(
            Get-ChildItem -LiteralPath $cacheRoot -Directory -Force |
                Where-Object {
                    $_.Name.Contains("-a$($manifest.app_id)-s")
                }
        )
        if ($cacheCandidates.Count -ne 1) {
            throw (
                "$($case.Name) expected exactly one immutable cache " +
                "generation, found $($cacheCandidates.Count).")
        }
        $cache = $cacheCandidates[0].FullName
        foreach ($name in @(
            "SyntheticTrainer.exe",
            "TrainerDeckBridge.dll",
            "trainerdeck-bridge.json"
        )) {
            if (-not (Test-Path -LiteralPath (Join-Path $cache $name))) {
                throw "$($case.Name) prepare-only output is missing: $name"
            }
        }

        $cachedBridge = [Mono.Cecil.AssemblyDefinition]::ReadAssembly(
            (Join-Path $cache "TrainerDeckBridge.dll"))
        try {
            if ($cachedBridge.Name.Name -ne "TrainerDeckBridge") {
                throw "$($case.Name) cached payload has the wrong assembly name."
            }
            if (-not $cachedBridge.MainModule.RuntimeVersion.StartsWith(
                    $case.RuntimePrefix,
                    [StringComparison]::OrdinalIgnoreCase)) {
                throw "$($case.Name) selected the wrong metadata runtime."
            }
            $mscorlib = @(
                $cachedBridge.MainModule.AssemblyReferences |
                    Where-Object { $_.Name -eq "mscorlib" }
            )
            if ($mscorlib.Count -ne 1 `
                -or $mscorlib[0].Version.Major -ne $case.MscorlibMajor) {
                throw "$($case.Name) selected the wrong mscorlib generation."
            }
        }
        finally {
            $cachedBridge.Dispose()
        }
    }

    Write-Output (
        "PASS embedded Host prepares CLR2 and CLR4 synthetic UIs without " +
        "external bridge payloads")
}
finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if (
        $resolvedTemporary.StartsWith(
            $temporaryParent,
            [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemporary).StartsWith(
            "TrainerDeck-synthetic-prepare-",
            [StringComparison]::Ordinal)
    ) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force `
            -ErrorAction SilentlyContinue
    }
}
