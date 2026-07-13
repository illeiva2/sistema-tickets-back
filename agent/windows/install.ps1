[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BaseUrl,

    [System.Security.SecureString]$EnrollmentToken,

    [string]$InstallDirectory = (Join-Path $env:ProgramFiles "GRF\ITAgent"),

    [string]$DataDirectory = (Join-Path $env:ProgramData "GRF\ITAgent"),

    [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$TaskName = "GRF-IT-Agent"
$ExecutableName = "GRF.ITAgent.exe"

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

function Set-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow

    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($administratorsSid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $systemSid, $rights, $inheritance, $propagation, $allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $administratorsSid, $rights, $inheritance, $propagation, $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
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

function Write-AtomicUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Contents
    )

    $temporaryPath = "$Path.tmp"
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Contents, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Write-EnrollmentToken {
    param(
        [Parameter(Mandatory = $true)][System.Security.SecureString]$Token,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $pointer = [IntPtr]::Zero
    $plaintext = $null
    try {
        $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
        $plaintext = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plaintext -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw "El token de enrolamiento debe tener 43 caracteres base64url."
        }
        Write-AtomicUtf8File -Path $Path -Contents $plaintext
    }
    finally {
        $plaintext = $null
        if ($pointer -ne [IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
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
if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Este paquete requiere Windows x64."
}

$baseUri = $null
if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$baseUri) `
    -or $baseUri.Scheme -ne [Uri]::UriSchemeHttps `
    -or -not [string]::IsNullOrEmpty($baseUri.UserInfo) `
    -or -not [string]::IsNullOrEmpty($baseUri.Query) `
    -or -not [string]::IsNullOrEmpty($baseUri.Fragment)) {
    throw "BaseUrl debe ser una URL HTTPS sin credenciales, query ni fragmento."
}

$installPath = Get-SafeChildDirectoryPath -Path $InstallDirectory -AllowedParent $env:ProgramFiles
$dataPath = Get-SafeChildDirectoryPath -Path $DataDirectory -AllowedParent $env:ProgramData
$sourceExecutable = Join-Path $PSScriptRoot $ExecutableName
$sourceConfig = Join-Path $PSScriptRoot "config.example.json"
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
    throw "Ejecute install.ps1 desde la carpeta publicada que contiene el ejecutable y config.example.json."
}

if (-not $PSCmdlet.ShouldProcess($installPath, "Instalar o actualizar GRF IT Agent")) {
    return
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $TaskName
}

New-Item -ItemType Directory -Path $installPath -Force | Out-Null
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
Set-RestrictedAcl -Path $installPath
Set-RestrictedAcl -Path $dataPath

$installedExecutable = Join-Path $installPath $ExecutableName
Copy-Item -LiteralPath $sourceExecutable -Destination $installedExecutable -Force

$configPath = Join-Path $dataPath "config.json"
if (Test-Path -LiteralPath $configPath) {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
else {
    $configuration = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
}
$configuration.baseUrl = $baseUri.AbsoluteUri
Write-AtomicUtf8File -Path $configPath -Contents ($configuration | ConvertTo-Json -Depth 8)

$credentialFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "credentialFile"
$tokenFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "enrollmentTokenFile"
foreach ($propertyName in @("stateFile", "logFile", "lockFile")) {
    [void](Get-ValidatedLocalFileName -Configuration $configuration -PropertyName $propertyName)
}
$credentialPath = Join-Path $dataPath $credentialFileName
$tokenPath = Join-Path $dataPath $tokenFileName
if (-not (Test-Path -LiteralPath $credentialPath) -and -not (Test-Path -LiteralPath $tokenPath)) {
    if ($null -eq $EnrollmentToken) {
        $EnrollmentToken = Read-Host "Token de enrolamiento de un uso" -AsSecureString
    }
    Write-EnrollmentToken -Token $EnrollmentToken -Path $tokenPath
}

# Reapply the protected inheritance after all files are created. Only SYSTEM and the local
# Administrators group can read the config, pending token, DPAPI blob, state or log.
Set-RestrictedAcl -Path $installPath
Set-RestrictedAcl -Path $dataPath

$quotedConfigPath = '"' + $configPath.Replace('"', '""') + '"'
$action = New-ScheduledTaskAction `
    -Execute $installedExecutable `
    -Argument "--run --config $quotedConfigPath" `
    -WorkingDirectory $installPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "GRF IT Agent: inventario y telemetría saliente por HTTPS."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
}

Write-Host "GRF IT Agent instalado. Tarea: $TaskName"
