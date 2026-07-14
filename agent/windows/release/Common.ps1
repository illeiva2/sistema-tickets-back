Set-StrictMode -Version Latest

$script:ReleaseRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$script:RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$script:CryptoHelperProject = Join-Path $PSScriptRoot "CryptoHelper\Grf.ReleaseCrypto.csproj"
$script:SemVerPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
}

function Test-IsChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $parentPath = (Get-CanonicalPath $Parent) + [System.IO.Path]::DirectorySeparatorChar
    $candidatePath = Get-CanonicalPath $Candidate
    return $candidatePath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-PathOutsideRepository {
    param([Parameter(Mandatory = $true)][string]$Path)

    $canonicalPath = Get-CanonicalPath $Path
    if ($canonicalPath.Equals($script:RepositoryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-IsChildPath -Parent $script:RepositoryRoot -Candidate $canonicalPath)) {
        throw "La clave privada debe guardarse fuera del repositorio: $script:RepositoryRoot"
    }
}

function Assert-SemVer {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($Value -notmatch $script:SemVerPattern) {
        throw "$Name debe ser una versión SemVer válida (por ejemplo, 0.2.0 o 0.2.0-rc.1)."
    }
}

function Get-NormalizedExecutableFileVersion {
    param([Parameter(Mandatory = $true)][string]$ExecutablePath)

    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($ExecutablePath)
    $parsedVersion = $null
    if ([string]::IsNullOrWhiteSpace($versionInfo.FileVersion) -or
        -not [System.Version]::TryParse($versionInfo.FileVersion.Trim(), [ref]$parsedVersion) -or
        $parsedVersion.Major -lt 0 -or
        $parsedVersion.Minor -lt 0 -or
        $parsedVersion.Build -lt 0 -or
        $parsedVersion.Revision -gt 0) {
        throw "GRF.ITAgent.exe no contiene una FileVersion normalizable a major.minor.patch."
    }

    return "{0}.{1}.{2}" -f $parsedVersion.Major, $parsedVersion.Minor, $parsedVersion.Build
}

function Assert-GitHubReleaseUrl {
    param([Parameter(Mandatory = $true)][string]$Url)

    $uri = $null
    if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
        throw "La URL del artefacto no es válida."
    }

    if ($uri.Scheme -ne [System.Uri]::UriSchemeHttps) {
        throw "La URL del artefacto debe usar HTTPS."
    }

    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
        throw "La URL del artefacto no puede contener credenciales."
    }

    if (-not $uri.IsDefaultPort -and $uri.Port -ne 443) {
        throw "La URL del artefacto sólo puede usar el puerto HTTPS estándar."
    }

    $allowedHosts = @("github.com", "objects.githubusercontent.com")
    if ($allowedHosts -notcontains $uri.DnsSafeHost.ToLowerInvariant()) {
        throw "Host no permitido. Sólo se aceptan github.com y objects.githubusercontent.com."
    }

    if (-not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "La URL del artefacto no puede contener un fragmento."
    }

    if ($uri.DnsSafeHost.Equals("github.com", [System.StringComparison]::OrdinalIgnoreCase) -and
        $uri.AbsolutePath -notmatch '^/[^/]+/[^/]+/releases/download/[^/]+/[^/]+$') {
        throw "La URL de github.com debe apuntar a un asset de Releases (/owner/repo/releases/download/tag/archivo)."
    }

    return $uri
}

function Assert-ChannelReleaseUrl {
    param(
        [Parameter(Mandatory = $true)][System.Uri]$Uri,
        [Parameter(Mandatory = $true)][ValidateSet("pilot", "stable")][string]$Channel
    )

    if ($Uri.DnsSafeHost.Equals("github.com", [System.StringComparison]::OrdinalIgnoreCase)) {
        $segments = $Uri.AbsolutePath.Trim('/').Split('/')
        $releaseTag = [System.Uri]::UnescapeDataString($segments[4])
        if (-not $releaseTag.Equals($Channel, [System.StringComparison]::Ordinal)) {
            throw "El tag de la URL debe coincidir con el canal fijo '$Channel'."
        }
    }
}

function Get-DotNetExecutable {
    $command = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "No se encontró el SDK de .NET 10. Instalalo en la PC de IT antes de crear releases."
    }

    return $command.Source
}

function Get-ReleaseCryptoAssembly {
    param([Parameter(Mandatory = $true)][string]$DotNetExecutable)

    $assemblyPath = Join-Path $PSScriptRoot "CryptoHelper\bin\Release\net10.0\Grf.ReleaseCrypto.dll"
    $projectFiles = @(
        $script:CryptoHelperProject,
        (Join-Path $PSScriptRoot "CryptoHelper\Program.cs")
    )
    $mustBuild = -not (Test-Path -LiteralPath $assemblyPath -PathType Leaf)
    if (-not $mustBuild) {
        $assemblyTimestamp = (Get-Item -LiteralPath $assemblyPath).LastWriteTimeUtc
        foreach ($projectFile in $projectFiles) {
            if ((Get-Item -LiteralPath $projectFile).LastWriteTimeUtc -gt $assemblyTimestamp) {
                $mustBuild = $true
                break
            }
        }
    }

    if ($mustBuild) {
        $nugetConfig = Join-Path $PSScriptRoot "NuGet.Config"
        & $DotNetExecutable restore $script:CryptoHelperProject --configfile $nugetConfig --nologo | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo restaurar el helper criptográfico con el SDK de .NET 10."
        }

        & $DotNetExecutable build $script:CryptoHelperProject --configuration Release --no-restore --nologo | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudo compilar el helper criptográfico con el SDK de .NET 10."
        }
    }

    return $assemblyPath
}

function Invoke-ReleaseCrypto {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )

    $dotnet = Get-DotNetExecutable
    $previousTelemetry = $env:DOTNET_CLI_TELEMETRY_OPTOUT
    $previousNoLogo = $env:DOTNET_NOLOGO
    $previousAppData = $env:APPDATA
    $previousNugetPackages = $env:NUGET_PACKAGES
    try {
        $toolHome = Join-Path ([System.IO.Path]::GetTempPath()) "GRF.ITAgent.ReleaseTooling"
        New-Item -ItemType Directory -Path $toolHome -Force | Out-Null
        $env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
        $env:DOTNET_NOLOGO = "1"
        $env:APPDATA = $toolHome
        $env:NUGET_PACKAGES = Join-Path $toolHome "packages"
        $assemblyPath = Get-ReleaseCryptoAssembly -DotNetExecutable $dotnet
        & $dotnet $assemblyPath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $env:DOTNET_CLI_TELEMETRY_OPTOUT = $previousTelemetry
        $env:DOTNET_NOLOGO = $previousNoLogo
        $env:APPDATA = $previousAppData
        $env:NUGET_PACKAGES = $previousNugetPackages
    }

    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "El helper criptográfico finalizó con código $exitCode."
    }

    return $exitCode
}

function Test-DetachedSignature {
    param(
        [Parameter(Mandatory = $true)][string]$PublicKeyPath,
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath
    )

    $exitCode = Invoke-ReleaseCrypto -Arguments @(
        "verify",
        "--public", (Get-CanonicalPath $PublicKeyPath),
        "--input", (Get-CanonicalPath $InputPath),
        "--signature", (Get-CanonicalPath $SignaturePath)
    ) -AllowedExitCodes @(0, 3)
    return $exitCode -eq 0
}

function Write-Utf8WithoutBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-DeterministicGzip {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    $input = [System.IO.File]::Open(
        $InputPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $output = [System.IO.File]::Open(
            $OutputPath,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $gzip = [System.IO.Compression.GZipStream]::new(
                $output,
                [System.IO.Compression.CompressionLevel]::Optimal,
                $true
            )
            try {
                $input.CopyTo($gzip)
            }
            finally {
                $gzip.Dispose()
            }
        }
        finally {
            $output.Dispose()
        }
    }
    finally {
        $input.Dispose()
    }
}
