$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot
$buildDirectory = Join-Path $repository ".research\json-codec-build"
$compiler = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"

New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
$harness = Join-Path $buildDirectory "BridgeJsonCodecHarness.exe"

& $compiler `
    /nologo `
    /warnaserror `
    /target:exe `
    "/out:$harness" `
    (Join-Path $repository "bridge\Shared\JsonCodec.cs") `
    (Join-Path $repository "tests\BridgeJsonCodecHarness.cs")
if ($LASTEXITCODE -ne 0) {
    throw "Bridge JSON codec harness compilation failed."
}

& $harness
if ($LASTEXITCODE -ne 0) {
    throw "Bridge JSON codec harness failed."
}

$cecil = Join-Path $repository "bin\bridge\Mono.Cecil.dll"
Add-Type -Path $cecil
$artifacts = @(
    "TrainerDeckBridge.dll",
    "TrainerDeckBridgeLauncher.exe"
)
foreach ($artifact in $artifacts) {
    $path = Join-Path $repository ("bin\bridge\" + $artifact)
    $assembly = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($path)
    try {
        $forbidden = $assembly.MainModule.AssemblyReferences |
            Where-Object { $_.Name -eq "System.Web.Extensions" }
        if ($null -ne $forbidden) {
            throw "$artifact still references System.Web.Extensions."
        }
    }
    finally {
        $assembly.Dispose()
    }
}

Write-Output "PASS production artifacts have no System.Web.Extensions dependency"
