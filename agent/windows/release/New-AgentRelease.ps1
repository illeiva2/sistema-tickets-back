[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$PublishedDirectory,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidateSet("pilot", "stable")]
    [string]$Channel,

    [Parameter(Mandatory = $true)]
    [string]$DownloadUrl,

    [Parameter(Mandatory = $true)]
    [string]$PrivateKeyPath,

    [string]$PublicKeyPath,
    [string]$MinAgentVersion = "0.1.0",
    [datetime]$PublishedAt = [datetime]::UtcNow,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "out"),
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

Assert-SemVer -Value $Version -Name "Version"
Assert-SemVer -Value $MinAgentVersion -Name "MinAgentVersion"
$downloadUri = Assert-GitHubReleaseUrl -Url $DownloadUrl
Assert-ChannelReleaseUrl -Uri $downloadUri -Channel $Channel

$publishedPath = Get-CanonicalPath $PublishedDirectory
$privatePath = Get-CanonicalPath $PrivateKeyPath
$outputPath = Get-CanonicalPath $OutputDirectory
Assert-PathOutsideRepository -Path $privatePath

if (-not (Test-Path -LiteralPath $publishedPath -PathType Container)) {
    throw "No existe el directorio publicado: $publishedPath"
}
if (-not (Test-Path -LiteralPath $privatePath -PathType Leaf)) {
    throw "No existe la clave privada: $privatePath"
}
if ($outputPath.Equals($publishedPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    (Test-IsChildPath -Parent $publishedPath -Candidate $outputPath)) {
    throw "El directorio de salida no puede estar dentro del paquete publicado."
}

$executablePath = Join-Path $publishedPath "GRF.ITAgent.exe"
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "El paquete publicado no contiene GRF.ITAgent.exe."
}
if (((Get-Item -LiteralPath $executablePath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "GRF.ITAgent.exe no puede ser un enlace o punto de reanálisis."
}

$normalizedFileVersion = Get-NormalizedExecutableFileVersion -ExecutablePath $executablePath
$requestedVersionCore = [System.Text.RegularExpressions.Regex]::Match($Version, '^\d+\.\d+\.\d+').Value
if (-not $normalizedFileVersion.Equals($requestedVersionCore, [System.StringComparison]::Ordinal)) {
    throw "FileVersion de GRF.ITAgent.exe ($normalizedFileVersion) no coincide con Version ($requestedVersionCore)."
}

$executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
$sumFilePath = Join-Path $publishedPath "SHA256SUMS.txt"
if (Test-Path -LiteralPath $sumFilePath -PathType Leaf) {
    $sumContent = Get-Content -LiteralPath $sumFilePath -Raw
    $escapedName = [System.Text.RegularExpressions.Regex]::Escape("GRF.ITAgent.exe")
    $match = [System.Text.RegularExpressions.Regex]::Match(
        $sumContent,
        "(?im)^([a-f0-9]{64})\s+\*?$escapedName\s*$"
    )
    if (-not $match.Success -or $match.Groups[1].Value.ToLowerInvariant() -ne $executableHash) {
        throw "SHA256SUMS.txt no coincide con GRF.ITAgent.exe. Volvé a ejecutar publish.ps1."
    }
}

$artifactName = "GRF.ITAgent-$Version-win-x64.exe.gz"
$urlFileName = [System.IO.Path]::GetFileName([System.Uri]::UnescapeDataString($downloadUri.AbsolutePath))
if (-not $urlFileName.Equals($artifactName, [System.StringComparison]::Ordinal)) {
    throw "La URL debe terminar exactamente en $artifactName."
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$artifactPath = Join-Path $outputPath $artifactName
$manifestPath = Join-Path $outputPath "manifest-$Channel.json"
$signaturePath = "$manifestPath.sig"
$targets = @($artifactPath, $manifestPath, $signaturePath)
if (-not $Force) {
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target) {
            throw "Ya existe $target. Usá -Force para reemplazar únicamente los artefactos de esta release."
        }
    }
}

if (-not $PSCmdlet.ShouldProcess($outputPath, "Crear release firmada $Version ($Channel)")) {
    return
}

New-DeterministicGzip -InputPath $executablePath -OutputPath $artifactPath
$artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactSize = (Get-Item -LiteralPath $artifactPath).Length
$publishedAtUtc = $PublishedAt.ToUniversalTime().ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [System.Globalization.CultureInfo]::InvariantCulture
)

$manifest = [ordered]@{
    version = $Version
    channel = $Channel
    url = $downloadUri.AbsoluteUri
    sha256 = $artifactHash
    size = $artifactSize
    publishedAt = $publishedAtUtc
    minAgentVersion = $MinAgentVersion
}
$manifestJson = ($manifest | ConvertTo-Json -Compress) + "`n"
Write-Utf8WithoutBom -Path $manifestPath -Content $manifestJson

Invoke-ReleaseCrypto -Arguments @(
    "sign",
    "--private", $privatePath,
    "--input", $manifestPath,
    "--output", $signaturePath
) | Out-Null

$signatureContent = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
try {
    [void][System.Convert]::FromBase64String($signatureContent)
}
catch {
    throw "El helper criptográfico no produjo una firma Base64 válida."
}

$temporaryPublicKeyPath = $null
try {
    if ([string]::IsNullOrWhiteSpace($PublicKeyPath)) {
        $temporaryPublicKeyPath = Join-Path ([System.IO.Path]::GetTempPath()) ("grf-agent-release-public-" + [guid]::NewGuid().ToString("N") + ".pem")
        Invoke-ReleaseCrypto -Arguments @(
            "derive-public",
            "--private", $privatePath,
            "--public", $temporaryPublicKeyPath
        ) | Out-Null
        $verificationPublicKeyPath = $temporaryPublicKeyPath
    }
    else {
        $verificationPublicKeyPath = Get-CanonicalPath $PublicKeyPath
        if (-not (Test-Path -LiteralPath $verificationPublicKeyPath -PathType Leaf)) {
            throw "No existe la clave pública de verificación: $verificationPublicKeyPath"
        }
    }

    if (-not (Test-DetachedSignature -PublicKeyPath $verificationPublicKeyPath -InputPath $manifestPath -SignaturePath $signaturePath)) {
        throw "La verificación inmediata de la firma falló; no publiques estos artefactos."
    }
}
finally {
    if ($null -ne $temporaryPublicKeyPath -and (Test-Path -LiteralPath $temporaryPublicKeyPath)) {
        Remove-Item -LiteralPath $temporaryPublicKeyPath -Force
    }
}

Write-Host "Release lista para adjuntar en GitHub Releases:"
Write-Host "  Artefacto: $artifactPath"
Write-Host "  Manifiesto: $manifestPath"
Write-Host "  Firma: $signaturePath"

[pscustomobject]@{
    ArtifactPath = $artifactPath
    ManifestPath = $manifestPath
    SignaturePath = $signaturePath
    ExecutableSha256 = $executableHash
}
