[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles "GRF\ITAgent"),
    [string]$DataDirectory = (Join-Path $env:ProgramData "GRF\ITAgent"),
    [switch]$PurgeData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$TaskName = "GRF-IT-Agent"

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Ejecute este script desde PowerShell elevado como administrador."
    }
}

function Get-SafeChildDirectoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parentPath = [System.IO.Path]::GetFullPath($AllowedParent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parentPrefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    if ([string]::IsNullOrWhiteSpace($fullPath) `
        -or -not $fullPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "El directorio debe ser un descendiente de $parentPath."
    }
    return $fullPath
}

function Remove-DirectoryIfEmpty {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ((Test-Path -LiteralPath $Path -PathType Container) `
        -and -not (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Clear-PlaintextToken {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Se rechazó eliminar un token que es un enlace."
    }

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $zeros = [byte[]]::new(4096)
        $remaining = $stream.Length
        while ($remaining -gt 0) {
            $count = [int][Math]::Min($remaining, $zeros.Length)
            $stream.Write($zeros, 0, $count)
            $remaining -= $count
        }
        $stream.SetLength(0)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
    Remove-Item -LiteralPath $Path -Force
}

function Get-ValidatedLocalFileName {
    param(
        [Parameter(Mandatory = $true)][object]$Configuration,
        [Parameter(Mandatory = $true)][string]$PropertyName
    )

    $property = $Configuration.PSObject.Properties[$PropertyName]
    if ($null -eq $property) {
        throw "Falta $PropertyName en la configuración."
    }
    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($value) `
        -or $value.Length -gt 100 `
        -or $value -ne [System.IO.Path]::GetFileName($value) `
        -or $value.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0 `
        -or $value -eq "." `
        -or $value -eq "..") {
        throw "$PropertyName debe ser un nombre de archivo local seguro."
    }
    return $value
}

function Wait-ScheduledTaskStopped {
    param([Parameter(Mandatory = $true)][string]$Name)

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($null -eq $task -or [string]$task.State -ne "Running") {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "La tarea existente no se detuvo a tiempo."
}

Assert-Administrator
$installPath = Get-SafeChildDirectoryPath -Path $InstallDirectory -AllowedParent $env:ProgramFiles
$dataPath = Get-SafeChildDirectoryPath -Path $DataDirectory -AllowedParent $env:ProgramData
$dataFileNames = @{
    enrollmentTokenFile = "enrollment.token"
    credentialFile = "credentials.dat"
    stateFile = "state.json"
    logFile = "agent.log"
    lockFile = "agent.lock"
}
if ($PurgeData) {
    $existingConfigPath = Join-Path $dataPath "config.json"
    if (Test-Path -LiteralPath $existingConfigPath -PathType Leaf) {
        $existingConfiguration = Get-Content -LiteralPath $existingConfigPath -Raw | ConvertFrom-Json
        foreach ($propertyName in @("enrollmentTokenFile", "credentialFile", "stateFile", "logFile", "lockFile")) {
            $dataFileNames[$propertyName] = Get-ValidatedLocalFileName `
                -Configuration $existingConfiguration `
                -PropertyName $propertyName
        }
    }
}

if (-not $PSCmdlet.ShouldProcess($installPath, "Desinstalar GRF IT Agent")) {
    return
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$executablePath = Join-Path $installPath "GRF.ITAgent.exe"
if (Test-Path -LiteralPath $executablePath -PathType Leaf) {
    Remove-Item -LiteralPath $executablePath -Force
}
Remove-DirectoryIfEmpty -Path $installPath

if ($PurgeData -and (Test-Path -LiteralPath $dataPath -PathType Container)) {
    $tokenPath = Join-Path $dataPath $dataFileNames.enrollmentTokenFile
    Clear-PlaintextToken -Path $tokenPath
    Clear-PlaintextToken -Path "$tokenPath.tmp"
    $filesToDelete = @(
        "config.json",
        "config.json.tmp",
        $dataFileNames.credentialFile,
        "$($dataFileNames.credentialFile).tmp",
        $dataFileNames.stateFile,
        "$($dataFileNames.stateFile).tmp",
        $dataFileNames.logFile,
        "$($dataFileNames.logFile).1",
        $dataFileNames.lockFile
    ) | Select-Object -Unique
    foreach ($fileName in $filesToDelete) {
        $path = Join-Path $dataPath $fileName
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    Remove-DirectoryIfEmpty -Path $dataPath
}

Write-Host "GRF IT Agent desinstalado."
if (-not $PurgeData) {
    Write-Host "La configuración y la credencial cifrada se conservaron para una reinstalación."
}
