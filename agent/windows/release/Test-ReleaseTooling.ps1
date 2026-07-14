[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

$assertions = 0
function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $script:assertions++
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $threw = $false
    try {
        & $Action
    }
    catch {
        $threw = $true
    }
    Assert-True -Condition $threw -Message $Message
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("grf-release-test-" + [guid]::NewGuid().ToString("N"))
$publishedPath = Join-Path $tempRoot "published"
$keysPath = Join-Path $tempRoot "keys"
$outputOne = Join-Path $tempRoot "out-one"
$outputTwo = Join-Path $tempRoot "out-two"
$privateKeyPath = Join-Path $keysPath "private.pem"
$publicKeyPath = Join-Path $keysPath "public.pem"

try {
    New-Item -ItemType Directory -Path $publishedPath -Force | Out-Null
    New-Item -ItemType Directory -Path $keysPath -Force | Out-Null

    Invoke-ReleaseCrypto -Arguments @(
        "generate",
        "--private", $privateKeyPath,
        "--public", $publicKeyPath,
        "--key-size", "3072"
    ) | Out-Null

    $executablePath = Join-Path $publishedPath "GRF.ITAgent.exe"
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "CryptoHelper\bin\Release\net10.0\Grf.ReleaseCrypto.exe") -Destination $executablePath
    $executableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Utf8WithoutBom -Path (Join-Path $publishedPath "SHA256SUMS.txt") -Content "$executableHash  GRF.ITAgent.exe`r`n"

    $version = "0.2.0"
    $downloadUrl = "https://github.com/grf-it/agent-releases/releases/download/pilot/GRF.ITAgent-0.2.0-win-x64.exe.gz"
    $fixedDate = [datetime]::Parse(
        "2026-07-13T18:00:00.000Z",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AdjustToUniversal
    )

    $first = & (Join-Path $PSScriptRoot "New-AgentRelease.ps1") `
        -PublishedDirectory $publishedPath `
        -Version $version `
        -Channel pilot `
        -DownloadUrl $downloadUrl `
        -PrivateKeyPath $privateKeyPath `
        -MinAgentVersion "0.1.0" `
        -PublishedAt $fixedDate `
        -OutputDirectory $outputOne

    $second = & (Join-Path $PSScriptRoot "New-AgentRelease.ps1") `
        -PublishedDirectory $publishedPath `
        -Version $version `
        -Channel pilot `
        -DownloadUrl $downloadUrl `
        -PrivateKeyPath $privateKeyPath `
        -MinAgentVersion "0.1.0" `
        -PublishedAt $fixedDate `
        -OutputDirectory $outputTwo

    Assert-True -Condition ((Get-FileHash $first.ArtifactPath -Algorithm SHA256).Hash -eq (Get-FileHash $second.ArtifactPath -Algorithm SHA256).Hash) -Message "GZip must be reproducible"
    Assert-True -Condition ((Get-Content $first.ManifestPath -Raw) -ceq (Get-Content $second.ManifestPath -Raw)) -Message "Manifest bytes must be deterministic"

    $decompressedPath = Join-Path $tempRoot "decompressed.exe"
    $compressedStream = [System.IO.File]::OpenRead($first.ArtifactPath)
    try {
        $gzipStream = [System.IO.Compression.GZipStream]::new(
            $compressedStream,
            [System.IO.Compression.CompressionMode]::Decompress
        )
        try {
            $decompressedStream = [System.IO.File]::Create($decompressedPath)
            try {
                $gzipStream.CopyTo($decompressedStream)
            }
            finally {
                $decompressedStream.Dispose()
            }
        }
        finally {
            $gzipStream.Dispose()
        }
    }
    finally {
        $compressedStream.Dispose()
    }
    Assert-True -Condition ((Get-FileHash $decompressedPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $executableHash) -Message "GZip must contain only the published executable bytes"

    $manifest = Get-Content -LiteralPath $first.ManifestPath -Raw | ConvertFrom-Json
    $propertyNames = @($manifest.PSObject.Properties.Name)
    $expectedNames = @("version", "channel", "url", "sha256", "size", "publishedAt", "minAgentVersion")
    Assert-True -Condition (($propertyNames -join ",") -ceq ($expectedNames -join ",")) -Message "Manifest contract must contain exactly seven ordered fields"
    Assert-True -Condition ($manifest.version -ceq $version) -Message "Manifest version"
    Assert-True -Condition ($manifest.channel -ceq "pilot") -Message "Manifest channel"
    Assert-True -Condition ($manifest.url -ceq $downloadUrl) -Message "Manifest URL"
    Assert-True -Condition ($manifest.sha256 -ceq (Get-FileHash $first.ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()) -Message "Manifest artifact hash"
    Assert-True -Condition ([int64]$manifest.size -eq (Get-Item $first.ArtifactPath).Length) -Message "Manifest artifact size"
    Assert-True -Condition ($manifest.publishedAt -ceq "2026-07-13T18:00:00.000Z") -Message "Manifest UTC date"
    Assert-True -Condition ($manifest.minAgentVersion -ceq "0.1.0") -Message "Manifest minimum agent version"

    Assert-Throws -Action {
        & (Join-Path $PSScriptRoot "New-AgentRelease.ps1") `
            -PublishedDirectory $publishedPath `
            -Version "0.2.1" `
            -Channel pilot `
            -DownloadUrl "https://github.com/grf-it/agent-releases/releases/download/pilot/GRF.ITAgent-0.2.1-win-x64.exe.gz" `
            -PrivateKeyPath $privateKeyPath `
            -OutputDirectory (Join-Path $tempRoot "wrong-version")
    } -Message "Reject a version that differs from the executable FileVersion"

    Assert-True -Condition (Test-DetachedSignature -PublicKeyPath $publicKeyPath -InputPath $first.ManifestPath -SignaturePath $first.SignaturePath) -Message "RSA-PSS signature must verify"
    $signatureText = (Get-Content -LiteralPath $first.SignaturePath -Raw).Trim()
    Assert-True -Condition ([System.Convert]::FromBase64String($signatureText).Length -eq 384) -Message "3072-bit signature must be Base64 encoded"

    $tamperedManifest = Join-Path $tempRoot "tampered.json"
    $tamperedContent = (Get-Content -LiteralPath $first.ManifestPath -Raw).Replace('"pilot"', '"stable"')
    Write-Utf8WithoutBom -Path $tamperedManifest -Content $tamperedContent
    Assert-True -Condition (-not (Test-DetachedSignature -PublicKeyPath $publicKeyPath -InputPath $tamperedManifest -SignaturePath $first.SignaturePath)) -Message "Tampering must invalidate signature"

    foreach ($invalidUrl in @(
        "http://github.com/org/repo/file.gz",
        "https://github.com.evil.example/file.gz",
        "https://user:pass@github.com/file.gz",
        "https://github.com/org/repo/GRF.ITAgent-0.2.0-win-x64.exe.gz",
        "https://raw.githubusercontent.com/org/repo/file.gz",
        "https://github.com:444/org/repo/file.gz"
    )) {
        Assert-Throws -Action { Assert-GitHubReleaseUrl -Url $invalidUrl | Out-Null } -Message "Reject unsafe URL: $invalidUrl"
    }
    Assert-True -Condition ((Assert-GitHubReleaseUrl -Url $downloadUrl).DnsSafeHost -ceq "github.com") -Message "Accept exact GitHub host"
    Assert-Throws -Action { Assert-ChannelReleaseUrl -Uri ([uri]"https://github.com/grf-it/agent-releases/releases/download/stable/GRF.ITAgent-0.2.0-win-x64.exe.gz") -Channel pilot } -Message "Reject a release tag that does not match the channel"
    Assert-Throws -Action { Assert-PathOutsideRepository -Path (Join-Path $script:RepositoryRoot "private.pem") } -Message "Reject private keys inside repository"
    Assert-Throws -Action { Assert-SemVer -Value "v1.0" -Name "Version" } -Message "Reject invalid SemVer"

    $parserFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1" -File
    foreach ($parserFile in $parserFiles) {
        $tokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            $parserFile.FullName,
            [ref]$tokens,
            [ref]$parseErrors
        )
        Assert-True -Condition ($parseErrors.Count -eq 0) -Message "PowerShell parser errors in $($parserFile.Name)"
    }

    Write-Host "Release tooling validation passed: $assertions assertions."
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
