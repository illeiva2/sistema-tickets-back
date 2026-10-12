#Requires -Version 5.1
<#
.SYNOPSIS
  Prueba y publica el colector de red como un único ejecutable autocontenido (no necesita el
  runtime de .NET en el servidor) en artifacts\win-x64, junto con los scripts de instalación.
#>
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$project = Join-Path $root 'src\Grf.NetCollector\Grf.NetCollector.csproj'
$tests = Join-Path $root 'tests\Grf.NetCollector.Tests\Grf.NetCollector.Tests.csproj'
$output = Join-Path $root 'artifacts\win-x64'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'

if (-not $SkipTests) {
    & dotnet run --project $tests -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Las pruebas del colector fallaron: no se publica.' }
}

if (Test-Path $output) { Remove-Item -Recurse -Force $output }

# Comprimido: el ejecutable pasa de ~74 MB a ~35 MB, que es lo que hay que copiar a srv-datos.
& dotnet publish $project -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None -o $output
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish falló.' }

foreach ($file in 'install.ps1', 'uninstall.ps1', 'appsettings.example.json', 'README.md') {
    Copy-Item (Join-Path $root $file) $output
}

$sums = Get-ChildItem $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
}
Set-Content -Path (Join-Path $output 'SHA256SUMS.txt') -Value $sums -Encoding ascii
Write-Host "Listo: $output"
Get-ChildItem $output | Select-Object Name, Length | Format-Table -AutoSize
