[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "artifacts\win-x64"),
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$env:DOTNET_NOLOGO = "1"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = (Get-CanonicalPath $Parent) + [System.IO.Path]::DirectorySeparatorChar
    $childPath = Get-CanonicalPath $Child
    if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "El directorio de salida debe estar dentro de agent/windows."
    }
}

$projectPath = Join-Path $PSScriptRoot "src\Grf.ItAgent\Grf.ItAgent.csproj"
$testProjectPath = Join-Path $PSScriptRoot "tests\Grf.ItAgent.Tests\Grf.ItAgent.Tests.csproj"
$outputPath = Get-CanonicalPath $OutputDirectory
Assert-ChildPath -Parent $PSScriptRoot -Child $outputPath

[xml]$project = Get-Content -LiteralPath $projectPath -Raw
$targetFramework = [string]$project.Project.PropertyGroup.TargetFramework
if (-not $targetFramework.StartsWith("net10.0", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release gate: el agente productivo debe apuntar a net10.0-windows."
}

if (-not $SkipTests) {
    & (Join-Path $PSScriptRoot "tests\validate-scripts.ps1")
    & dotnet run --project $testProjectPath --configuration Release
    if ($LASTEXITCODE -ne 0) {
        throw "Las pruebas del agente fallaron."
    }
}

if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$publishArguments = @(
    "publish",
    $projectPath,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "true",
    "--output", $outputPath,
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true",
    "-p:DebugType=None",
    "-p:DebugSymbols=false"
)
& dotnet @publishArguments
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish falló."
}

foreach ($fileName in @("install.ps1", "uninstall.ps1", "config.example.json", "README.md")) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $fileName) -Destination $outputPath -Force
}

$executablePath = Join-Path $outputPath "GRF.ITAgent.exe"
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "La publicación no produjo GRF.ITAgent.exe."
}

$hash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(
    (Join-Path $outputPath "SHA256SUMS.txt"),
    "$hash  GRF.ITAgent.exe`r`n",
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Publicación self-contained win-x64 lista en: $outputPath"
