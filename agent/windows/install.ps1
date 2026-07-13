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

function Get-SafeDirectChildDirectoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parentPath = [System.IO.Path]::GetFullPath($AllowedParent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $parentPrefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    if ([string]::IsNullOrWhiteSpace($fullPath) `
        -or -not $fullPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase) `
        -or -not ([System.IO.Path]::GetDirectoryName($fullPath)).Equals(
            $parentPath,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "El directorio debe ser un hijo directo de $parentPath."
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

function Set-RestrictedFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($administratorsSid)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $allow))
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($administratorsSid, $rights, $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-NoReparseTraversal {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$Target,
        [switch]$AllowMissing
    )

    $rootPath = [System.IO.Path]::GetFullPath($TrustedRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $targetPath = [System.IO.Path]::GetFullPath($Target).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $rootPrefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
    if (-not $targetPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) `
        -and -not $targetPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "La ruta salió del root confiable."
    }

    $rootItem = Get-Item -LiteralPath $rootPath -Force
    if (-not $rootItem.PSIsContainer `
        -or ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "El root confiable no es un directorio físico."
    }

    $relative = if ($targetPath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        ""
    }
    else {
        $targetPath.Substring($rootPrefix.Length)
    }
    $current = $rootPath
    $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar)
    foreach ($segment in @($relative.Split($separators, [System.StringSplitOptions]::RemoveEmptyEntries))) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) {
            if ($AllowMissing) {
                continue
            }
            throw "Falta un componente esperado de la ruta segura."
        }
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSIsContainer `
            -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Se rechazó una ruta con archivo, junction o enlace simbólico."
        }
    }
}

function Assert-RestrictedDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $allowedSids = @("S-1-5-18", "S-1-5-32-544")
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowedSids) {
        throw "El owner del directorio no es confiable."
    }
    $rules = $acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
            -and $rule.IdentityReference.Value -notin $allowedSids) {
            throw "El directorio conserva permisos para una identidad no confiable."
        }
    }
    foreach ($sid in $allowedSids) {
        $fullControl = $rules | Where-Object {
            $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
                -and $_.IdentityReference.Value -eq $sid `
                -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) `
                    -eq [System.Security.AccessControl.FileSystemRights]::FullControl
        } | Select-Object -First 1
        if ($null -eq $fullControl) {
            throw "Falta FullControl para una identidad administrativa requerida."
        }
    }
}

function Assert-AdministrativeOwner {
    param([Parameter(Mandatory = $true)][string]$Path)

    $allowedOwnerSids = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)
    [void]$allowedOwnerSids.Add("S-1-5-18")
    [void]$allowedOwnerSids.Add("S-1-5-32-544")
    [void]$allowedOwnerSids.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    try {
        foreach ($member in @(Get-LocalGroupMember -SID "S-1-5-32-544" -ErrorAction Stop)) {
            if ($null -ne $member.SID) {
                [void]$allowedOwnerSids.Add($member.SID.Value)
            }
        }
    }
    catch {
        # Windows Server images without LocalAccounts still accept SYSTEM, Administrators and
        # the currently elevated administrator. Any ambiguous owner fails closed below.
    }

    $owner = (Get-Acl -LiteralPath $Path).GetOwner(
        [System.Security.Principal.SecurityIdentifier]).Value
    if (-not $allowedOwnerSids.Contains($owner)) {
        throw "El directorio GRF preexistente no tiene owner administrativo; revise y elimínelo manualmente."
    }
}

function Assert-RegularFileOrMissing {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
        return
    }
    if ($item.PSIsContainer `
        -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Se rechazó un archivo que es directorio, junction o enlace simbólico."
    }
}

function Initialize-SecureAgentDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$VendorRoot,
        [Parameter(Mandatory = $true)][string]$AgentPath
    )

    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot -AllowMissing
    $vendorExisted = Test-Path -LiteralPath $VendorRoot
    if ($vendorExisted) {
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
        Assert-AdministrativeOwner -Path $VendorRoot
    }
    else {
        New-Item -ItemType Directory -Path $VendorRoot | Out-Null
    }
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
    Set-RestrictedAcl -Path $VendorRoot
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
    Assert-RestrictedDirectoryAcl -Path $VendorRoot

    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath -AllowMissing
    if (Test-Path -LiteralPath $AgentPath) {
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
        # A pre-existing target not created by an earlier secure install is not touched.
        Assert-RestrictedDirectoryAcl -Path $AgentPath
    }
    else {
        New-Item -ItemType Directory -Path $AgentPath | Out-Null
    }
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
    Set-RestrictedAcl -Path $AgentPath
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
    Assert-RestrictedDirectoryAcl -Path $AgentPath
}

function Assert-SecureAgentPaths {
    param(
        [Parameter(Mandatory = $true)][string]$InstallPath,
        [Parameter(Mandatory = $true)][string]$DataPath,
        [Parameter(Mandatory = $true)][string]$InstallVendorRoot,
        [Parameter(Mandatory = $true)][string]$DataVendorRoot
    )

    Assert-NoReparseTraversal -TrustedRoot $env:ProgramFiles -Target $InstallPath
    Assert-NoReparseTraversal -TrustedRoot $env:ProgramData -Target $DataPath
    foreach ($directory in @($InstallVendorRoot, $DataVendorRoot, $InstallPath, $DataPath)) {
        Assert-RestrictedDirectoryAcl -Path $directory
    }
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
        Assert-RegularFileOrMissing -Path $Path
        Assert-RegularFileOrMissing -Path $temporaryPath
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

$installVendorRoot = Join-Path $env:ProgramFiles "GRF"
$dataVendorRoot = Join-Path $env:ProgramData "GRF"
$installPath = Get-SafeDirectChildDirectoryPath -Path $InstallDirectory -AllowedParent $installVendorRoot
$dataPath = Get-SafeDirectChildDirectoryPath -Path $DataDirectory -AllowedParent $dataVendorRoot
$sourceExecutable = Join-Path $PSScriptRoot $ExecutableName
$sourceConfig = Join-Path $PSScriptRoot "config.example.json"
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
    throw "Ejecute install.ps1 desde la carpeta publicada que contiene el ejecutable y config.example.json."
}

if (-not $PSCmdlet.ShouldProcess($installPath, "Instalar o actualizar GRF IT Agent")) {
    return
}

Initialize-SecureAgentDirectory `
    -TrustedRoot $env:ProgramFiles `
    -VendorRoot $installVendorRoot `
    -AgentPath $installPath
Initialize-SecureAgentDirectory `
    -TrustedRoot $env:ProgramData `
    -VendorRoot $dataVendorRoot `
    -AgentPath $dataPath
Assert-SecureAgentPaths `
    -InstallPath $installPath `
    -DataPath $dataPath `
    -InstallVendorRoot $installVendorRoot `
    -DataVendorRoot $dataVendorRoot

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $TaskName
}

$installedExecutable = Join-Path $installPath $ExecutableName
Assert-RegularFileOrMissing -Path $installedExecutable
if (Test-Path -LiteralPath $installedExecutable) {
    Remove-Item -LiteralPath $installedExecutable -Force
}
Copy-Item -LiteralPath $sourceExecutable -Destination $installedExecutable -Force
Assert-RegularFileOrMissing -Path $installedExecutable
Set-RestrictedFileAcl -Path $installedExecutable

$configPath = Join-Path $dataPath "config.json"
Assert-SecureAgentPaths `
    -InstallPath $installPath `
    -DataPath $dataPath `
    -InstallVendorRoot $installVendorRoot `
    -DataVendorRoot $dataVendorRoot
Assert-RegularFileOrMissing -Path $configPath
if (Test-Path -LiteralPath $configPath) {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
else {
    $configuration = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
}
$configuration.baseUrl = $baseUri.AbsoluteUri

$credentialFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "credentialFile"
$tokenFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "enrollmentTokenFile"
$stateFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "stateFile"
$logFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "logFile"
$lockFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "lockFile"
Write-AtomicUtf8File -Path $configPath -Contents ($configuration | ConvertTo-Json -Depth 8)
Assert-RegularFileOrMissing -Path $configPath
Set-RestrictedFileAcl -Path $configPath

$credentialPath = Join-Path $dataPath $credentialFileName
$tokenPath = Join-Path $dataPath $tokenFileName
foreach ($dataFile in @(
    $credentialPath,
    "$credentialPath.tmp",
    $tokenPath,
    "$tokenPath.tmp",
    (Join-Path $dataPath $stateFileName),
    (Join-Path $dataPath "$stateFileName.tmp"),
    (Join-Path $dataPath $logFileName),
    (Join-Path $dataPath "$logFileName.1"),
    (Join-Path $dataPath $lockFileName)
)) {
    Assert-RegularFileOrMissing -Path $dataFile
    if (Test-Path -LiteralPath $dataFile -PathType Leaf) {
        Set-RestrictedFileAcl -Path $dataFile
    }
}
if (-not (Test-Path -LiteralPath $credentialPath) -and -not (Test-Path -LiteralPath $tokenPath)) {
    if ($null -eq $EnrollmentToken) {
        $EnrollmentToken = Read-Host "Token de enrolamiento de un uso" -AsSecureString
    }
    Write-EnrollmentToken -Token $EnrollmentToken -Path $tokenPath
    Assert-RegularFileOrMissing -Path $tokenPath
    Set-RestrictedFileAcl -Path $tokenPath
}

# Reapply the protected inheritance after all files are created. Only SYSTEM and the local
# Administrators group can read the config, pending token, DPAPI blob, state or log.
Set-RestrictedAcl -Path $installPath
Set-RestrictedAcl -Path $dataPath
Assert-SecureAgentPaths `
    -InstallPath $installPath `
    -DataPath $dataPath `
    -InstallVendorRoot $installVendorRoot `
    -DataVendorRoot $dataVendorRoot
Assert-RegularFileOrMissing -Path $installedExecutable
Assert-RegularFileOrMissing -Path $configPath

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
Assert-SecureAgentPaths `
    -InstallPath $installPath `
    -DataPath $dataPath `
    -InstallVendorRoot $installVendorRoot `
    -DataVendorRoot $dataVendorRoot
Assert-RegularFileOrMissing -Path $installedExecutable
Assert-RegularFileOrMissing -Path $configPath
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
}

Write-Host "GRF IT Agent instalado. Tarea: $TaskName"
