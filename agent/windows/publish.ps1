[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$SkipTests,
    [ValidateSet("stable", "pilot")]
    [string]$UpdateChannel,
    [string]$UpdatePublicKeyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$env:DOTNET_NOLOGO = "1"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "artifacts\win-x64"
}

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
$hasUpdateChannel = -not [string]::IsNullOrWhiteSpace($UpdateChannel)
$hasUpdatePublicKey = -not [string]::IsNullOrWhiteSpace($UpdatePublicKeyPath)
if ($hasUpdateChannel -ne $hasUpdatePublicKey) {
    throw "UpdateChannel y UpdatePublicKeyPath deben indicarse juntos."
}

function Assert-PhysicalOutputPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Output
    )

    $rootPath = Get-CanonicalPath $Root
    $outputPath = Get-CanonicalPath $Output
    Assert-ChildPath -Parent $rootPath -Child $outputPath

    $rootItem = Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer `
        -or ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "agent/windows debe ser un directorio físico, no un junction o enlace."
    }

    $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
    $relativePath = $outputPath.Substring($rootPrefix.Length)
    $currentPath = $rootPath
    $separators = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
    foreach ($segment in @($relativePath.Split(
        $separators,
        [System.StringSplitOptions]::RemoveEmptyEntries))) {
        $currentPath = Join-Path $currentPath $segment
        $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            # Once an ancestor is missing, no deeper physical child can exist yet.
            break
        }
        if (-not $item.PSIsContainer `
            -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "El directorio de salida o uno de sus ancestros es archivo, junction o enlace."
        }
    }
}

function Assert-PathWithinOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Output,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $outputPath = Get-CanonicalPath $Output
    $candidatePath = Get-CanonicalPath $Candidate
    $outputPrefix = $outputPath + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidatePath.Equals($outputPath, [System.StringComparison]::OrdinalIgnoreCase) `
        -and -not $candidatePath.StartsWith(
            $outputPrefix,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "La limpieza intentó salir del directorio de salida acotado."
    }
    return $candidatePath
}

function Remove-PhysicalOutputTree {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Output,
        [ValidateRange(1, 100000)][int]$MaxItems = 20000,
        [ValidateRange(1, 128)][int]$MaxDepth = 32
    )

    Assert-PhysicalOutputPath -Root $Root -Output $Output
    $outputPath = Assert-PathWithinOutput -Output $Output -Candidate $Output
    $outputItem = Get-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $outputItem) {
        return
    }
    if (-not $outputItem.PSIsContainer `
        -or ($outputItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "El output no es un directorio físico."
    }

    # Phase one is read-only: audit the complete tree before deleting a single item.
    $pending = [System.Collections.Stack]::new()
    $files = [System.Collections.Generic.List[string]]::new()
    $directories = [System.Collections.Generic.List[object]]::new()
    $pending.Push([pscustomobject]@{ Path = $outputPath; Depth = 0 })
    $itemCount = 1
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $currentPath = Assert-PathWithinOutput `
            -Output $outputPath `
            -Candidate ([string]$current.Path)
        $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (-not $currentItem.PSIsContainer `
            -or ($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "El árbol de salida contiene un directorio no físico."
        }
        [void]$directories.Add([pscustomobject]@{
            Path = $currentPath
            Depth = [int]$current.Depth
        })

        foreach ($child in @(Get-ChildItem -LiteralPath $currentPath -Force -ErrorAction Stop)) {
            $itemCount++
            if ($itemCount -gt $MaxItems) {
                throw "La limpieza superó el máximo de $MaxItems elementos."
            }
            $childDepth = [int]$current.Depth + 1
            if ($childDepth -gt $MaxDepth) {
                throw "La limpieza superó la profundidad máxima de $MaxDepth."
            }
            $childPath = Assert-PathWithinOutput `
                -Output $outputPath `
                -Candidate $child.FullName
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "La limpieza rechazó un junction o enlace dentro del output."
            }
            if ($child.PSIsContainer) {
                $pending.Push([pscustomobject]@{
                    Path = $childPath
                    Depth = $childDepth
                })
            }
            else {
                [void]$files.Add($childPath)
            }
        }
    }

    # Phase two revalidates each item and removes only literal files and empty physical
    # directories, deepest first. No command follows or recursively traverses a reparse point.
    foreach ($filePath in $files) {
        $safeFilePath = Assert-PathWithinOutput -Output $outputPath -Candidate $filePath
        $fileItem = Get-Item -LiteralPath $safeFilePath -Force -ErrorAction Stop
        if ($fileItem.PSIsContainer `
            -or ($fileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Un archivo cambió de tipo durante la limpieza; se abortó."
        }
        Remove-Item -LiteralPath $safeFilePath -Force
    }

    foreach ($directory in @($directories | Sort-Object Depth -Descending)) {
        $safeDirectoryPath = Assert-PathWithinOutput `
            -Output $outputPath `
            -Candidate ([string]$directory.Path)
        $directoryItem = Get-Item -LiteralPath $safeDirectoryPath -Force -ErrorAction Stop
        if (-not $directoryItem.PSIsContainer `
            -or ($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Un directorio cambió de tipo durante la limpieza; se abortó."
        }
        if (@(Get-ChildItem -LiteralPath $safeDirectoryPath -Force -ErrorAction Stop).Count -ne 0) {
            throw "El árbol de salida cambió durante la limpieza; se abortó."
        }
        Remove-Item -LiteralPath $safeDirectoryPath -Force
    }
}

Assert-PhysicalOutputPath -Root $PSScriptRoot -Output $outputPath

$updatePublicKey = $null
if ($hasUpdatePublicKey) {
    $publicKeyPath = Get-CanonicalPath $UpdatePublicKeyPath
    $publicKeyItem = Get-Item -LiteralPath $publicKeyPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $publicKeyItem `
        -or $publicKeyItem.PSIsContainer `
        -or ($publicKeyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or $publicKeyItem.Length -le 0 `
        -or $publicKeyItem.Length -gt 16384) {
        throw "UpdatePublicKeyPath debe ser un archivo PEM físico de hasta 16 KiB."
    }
    $updatePublicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
    if ($updatePublicKey -notmatch '^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$' `
        -or $updatePublicKey -match 'PRIVATE KEY') {
        throw "UpdatePublicKeyPath no contiene una clave pública PEM válida."
    }
}

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
    Remove-PhysicalOutputTree -Root $PSScriptRoot -Output $outputPath
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
Assert-PhysicalOutputPath -Root $PSScriptRoot -Output $outputPath

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

foreach ($fileName in @(
    "install.ps1",
    "uninstall.ps1",
    "update-agent.ps1",
    "deploy-remotely.ps1",
    "config.example.json",
    "README.md"
)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $fileName) -Destination $outputPath -Force
}

if ($hasUpdatePublicKey) {
    $publishedConfigPath = Join-Path $outputPath "config.example.json"
    $publishedConfiguration = Get-Content -LiteralPath $publishedConfigPath -Raw |
        ConvertFrom-Json
    $publishedConfiguration.update.enabled = $true
    $publishedConfiguration.update.channel = $UpdateChannel
    $publishedConfiguration.update.manifestUrl =
        "https://github.com/illeiva2/grf-it-agent-releases/releases/download/" +
        "$UpdateChannel/manifest-$UpdateChannel.json"
    $publishedConfiguration.update.publicKeyPem = $updatePublicKey
    [System.IO.File]::WriteAllText(
        $publishedConfigPath,
        ($publishedConfiguration | ConvertTo-Json -Depth 8),
        [System.Text.UTF8Encoding]::new($false))
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
