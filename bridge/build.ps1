param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$bridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $bridgeRoot
$solution = Join-Path $bridgeRoot "TrainerDeckBridge.sln"
$artifacts = Join-Path $repositoryRoot "bin\bridge"
$localDotnet = Join-Path $repositoryRoot ".tools\dotnet\dotnet.exe"
$dotnetCommand = if (Test-Path -LiteralPath $localDotnet) {
    $localDotnet
} else {
    (Get-Command dotnet -ErrorAction Stop).Source
}
$env:DOTNET_CLI_HOME = Join-Path $repositoryRoot ".tools\dotnet-home"
$env:NUGET_PACKAGES = Join-Path $repositoryRoot ".tools\nuget-packages"

& $dotnetCommand restore $solution
if ($LASTEXITCODE -ne 0) {
    throw "dotnet restore failed with exit code $LASTEXITCODE"
}
& $dotnetCommand build $solution --configuration $Configuration --no-restore
if ($LASTEXITCODE -ne 0) {
    throw "dotnet build failed with exit code $LASTEXITCODE"
}

$resolvedArtifacts = [System.IO.Path]::GetFullPath($artifacts)
$expectedArtifacts = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot "bin\bridge"))
if (-not [string]::Equals(
        $resolvedArtifacts,
        $expectedArtifacts,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean unexpected artifact path: $resolvedArtifacts"
}
if (Test-Path -LiteralPath $resolvedArtifacts) {
    Remove-Item -LiteralPath $resolvedArtifacts -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedArtifacts -Force | Out-Null

$bridgeOutput = Join-Path $bridgeRoot "TrainerDeckBridge\bin\$Configuration\net35"
$launcherOutput = Join-Path $bridgeRoot "TrainerDeckBridgeLauncher\bin\$Configuration\net462"

Copy-Item (Join-Path $bridgeOutput "TrainerDeckBridge.dll") $resolvedArtifacts
Copy-Item (Join-Path $launcherOutput "TrainerDeckBridgeLauncher.exe") $resolvedArtifacts
Copy-Item (Join-Path $launcherOutput "Mono.Cecil.dll") $resolvedArtifacts
Copy-Item (Join-Path $bridgeRoot "trainerdeck-bridge.example.json") $resolvedArtifacts
Copy-Item (Join-Path $bridgeRoot "THIRD_PARTY_NOTICES.txt") $resolvedArtifacts

Write-Host "Bridge artifacts: $resolvedArtifacts"
