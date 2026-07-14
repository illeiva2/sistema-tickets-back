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
$UpdateTaskName = "GRF-IT-Agent-Updater"
$ExecutableName = "GRF.ITAgent.exe"
$UpdaterName = "update-agent.ps1"

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

function Wait-ScheduledTaskRunning {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateRange(1, 120)][int]$TimeoutSeconds = 30,
        [ValidateRange(1, 30)][int]$StableSeconds = 5
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $runningSince = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($null -ne $task -and [string]$task.State -eq "Running") {
            if ($null -eq $runningSince) {
                $runningSince = [DateTimeOffset]::UtcNow
            }
            elseif (([DateTimeOffset]::UtcNow - $runningSince).TotalSeconds -ge $StableSeconds) {
                return
            }
        }
        else {
            $runningSince = $null
        }
        Start-Sleep -Milliseconds 500
    }
    throw "La tarea $Name no permaneció Running durante $StableSeconds segundos."
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
$sourceUpdater = Join-Path $PSScriptRoot $UpdaterName
$sourceConfig = Join-Path $PSScriptRoot "config.example.json"
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $sourceUpdater -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $sourceConfig -PathType Leaf)) {
    throw "Ejecute install.ps1 desde la carpeta publicada completa."
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

$installedExecutable = Join-Path $installPath $ExecutableName
$stagedExecutable = "$installedExecutable.new"
$previousExecutable = "$installedExecutable.previous"
$installedUpdater = Join-Path $installPath $UpdaterName
$stagedUpdater = "$installedUpdater.new"
$previousUpdater = "$installedUpdater.previous"
$configPath = Join-Path $dataPath "config.json"
foreach ($sourceFile in @($sourceExecutable, $sourceUpdater, $sourceConfig)) {
    Assert-RegularFileOrMissing -Path $sourceFile
}
foreach ($installFile in @(
    $installedExecutable,
    $stagedExecutable,
    $previousExecutable,
    $installedUpdater,
    $stagedUpdater,
    $previousUpdater,
    $configPath
)) {
    Assert-RegularFileOrMissing -Path $installFile
}
$configExistedBefore = Test-Path -LiteralPath $configPath -PathType Leaf
$originalConfigContents = if ($configExistedBefore) {
    Get-Content -LiteralPath $configPath -Raw
}
else {
    $null
}

$existingUpdateTask = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
$updateTaskWasRunning = $null -ne $existingUpdateTask `
    -and [string]$existingUpdateTask.State -eq "Running"
$existingUpdateTaskXml = if ($null -ne $existingUpdateTask) {
    Export-ScheduledTask -TaskName $UpdateTaskName -ErrorAction Stop
}
else {
    $null
}
$existingMainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$mainTaskWasRunning = $null -ne $existingMainTask `
    -and [string]$existingMainTask.State -eq "Running"
$existingMainTaskXml = if ($null -ne $existingMainTask) {
    Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}
else {
    $null
}
$hadInstalledExecutable = $false
$hadInstalledUpdater = $false
$executableSwapAttempted = $false
$updaterSwapAttempted = $false
$configWriteAttempted = $false
$transactionCommitted = $false

try {
    if ($null -ne $existingUpdateTask) {
        Stop-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
        Wait-ScheduledTaskStopped -Name $UpdateTaskName
    }

foreach ($staleFile in @(
    $stagedExecutable,
    $previousExecutable,
    $stagedUpdater,
    $previousUpdater
)) {
    if (Test-Path -LiteralPath $staleFile -PathType Leaf) {
        Set-RestrictedFileAcl -Path $staleFile
        Remove-Item -LiteralPath $staleFile -Force
    }
}
Copy-Item -LiteralPath $sourceExecutable -Destination $stagedExecutable
Assert-RegularFileOrMissing -Path $stagedExecutable
Set-RestrictedFileAcl -Path $stagedExecutable
$sourceExecutableItem = Get-Item -LiteralPath $sourceExecutable -Force
$stagedExecutableItem = Get-Item -LiteralPath $stagedExecutable -Force
if ($sourceExecutableItem.Length -ne $stagedExecutableItem.Length `
    -or (Get-FileHash -LiteralPath $sourceExecutable -Algorithm SHA256).Hash `
        -ne (Get-FileHash -LiteralPath $stagedExecutable -Algorithm SHA256).Hash) {
    Remove-Item -LiteralPath $stagedExecutable -Force
    throw "La copia preparada del ejecutable no coincide con el paquete."
}

Copy-Item -LiteralPath $sourceUpdater -Destination $stagedUpdater
Assert-RegularFileOrMissing -Path $stagedUpdater
Set-RestrictedFileAcl -Path $stagedUpdater
$sourceUpdaterItem = Get-Item -LiteralPath $sourceUpdater -Force
$stagedUpdaterItem = Get-Item -LiteralPath $stagedUpdater -Force
if ($sourceUpdaterItem.Length -ne $stagedUpdaterItem.Length `
    -or (Get-FileHash -LiteralPath $sourceUpdater -Algorithm SHA256).Hash `
        -ne (Get-FileHash -LiteralPath $stagedUpdater -Algorithm SHA256).Hash) {
    Remove-Item -LiteralPath $stagedUpdater -Force
    throw "La copia preparada del updater no coincide con el paquete."
}

if ($null -ne $existingMainTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $TaskName
}
$hadInstalledExecutable = Test-Path -LiteralPath $installedExecutable -PathType Leaf
$executableSwapAttempted = $true
if ($hadInstalledExecutable) {
    # File.Replace performs a same-volume atomic swap and writes the exact prior binary
    # to .previous. At no point is the live path absent or half-copied.
    [System.IO.File]::Replace(
        $stagedExecutable,
        $installedExecutable,
        $previousExecutable,
        $true)
}
else {
    Move-Item -LiteralPath $stagedExecutable -Destination $installedExecutable
}
Set-RestrictedFileAcl -Path $installedExecutable

$hadInstalledUpdater = Test-Path -LiteralPath $installedUpdater -PathType Leaf
$updaterSwapAttempted = $true
if ($hadInstalledUpdater) {
    [System.IO.File]::Replace(
        $stagedUpdater,
        $installedUpdater,
        $previousUpdater,
        $true)
}
else {
    Move-Item -LiteralPath $stagedUpdater -Destination $installedUpdater
}
Set-RestrictedFileAcl -Path $installedUpdater

Assert-SecureAgentPaths `
    -InstallPath $installPath `
    -DataPath $dataPath `
    -InstallVendorRoot $installVendorRoot `
    -DataVendorRoot $dataVendorRoot
Assert-RegularFileOrMissing -Path $configPath
$sourceConfiguration = Get-Content -LiteralPath $sourceConfig -Raw | ConvertFrom-Json
if (Test-Path -LiteralPath $configPath) {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $sourceUpdateProperty = $sourceConfiguration.PSObject.Properties["update"]
    $existingUpdateProperty = $configuration.PSObject.Properties["update"]
    $sourceUpdateEnabled = $null -ne $sourceUpdateProperty `
        -and $null -ne $sourceUpdateProperty.Value `
        -and $null -ne $sourceUpdateProperty.Value.PSObject.Properties["enabled"] `
        -and $sourceUpdateProperty.Value.enabled -is [bool] `
        -and $sourceUpdateProperty.Value.enabled
    if ($sourceUpdateEnabled) {
        if ($null -eq $existingUpdateProperty) {
            $configuration | Add-Member `
                -MemberType NoteProperty `
                -Name "update" `
                -Value $sourceUpdateProperty.Value
        }
        else {
            $configuration.update = $sourceUpdateProperty.Value
        }
    }
    elseif (($null -eq $existingUpdateProperty -or $null -eq $existingUpdateProperty.Value) `
        -and $null -ne $sourceUpdateProperty) {
        if ($null -eq $existingUpdateProperty) {
            $configuration | Add-Member `
                -MemberType NoteProperty `
                -Name "update" `
                -Value $sourceUpdateProperty.Value
        }
        else {
            $configuration.update = $sourceUpdateProperty.Value
        }
    }
}
else {
    $configuration = $sourceConfiguration
}
$configuration.baseUrl = $baseUri.AbsoluteUri
$updateEnabled = $false
$updateProperty = $configuration.PSObject.Properties["update"]
if ($null -ne $updateProperty -and $null -ne $updateProperty.Value) {
    $enabledProperty = $updateProperty.Value.PSObject.Properties["enabled"]
    if ($null -ne $enabledProperty) {
        if ($enabledProperty.Value -isnot [bool]) {
            throw "update.enabled debe ser booleano."
        }
        $updateEnabled = [bool]$enabledProperty.Value
    }
}
if ($updateEnabled) {
    $channelProperty = $updateProperty.Value.PSObject.Properties["channel"]
    $manifestProperty = $updateProperty.Value.PSObject.Properties["manifestUrl"]
    $publicKeyProperty = $updateProperty.Value.PSObject.Properties["publicKeyPem"]
    if ($null -eq $channelProperty `
        -or $channelProperty.Value -isnot [string] `
        -or $channelProperty.Value -notin @("stable", "pilot")) {
        throw "update.channel debe ser stable o pilot."
    }
    $expectedManifestUrl = "https://github.com/illeiva2/grf-it-agent-releases/releases/download/" +
        "$($channelProperty.Value)/manifest-$($channelProperty.Value).json"
    if ($null -eq $manifestProperty `
        -or $manifestProperty.Value -isnot [string] `
        -or $manifestProperty.Value -ne $expectedManifestUrl) {
        throw "update.manifestUrl no coincide con el tag fijo del canal."
    }
    if ($null -eq $publicKeyProperty `
        -or $publicKeyProperty.Value -isnot [string] `
        -or [string]::IsNullOrWhiteSpace($publicKeyProperty.Value) `
        -or $publicKeyProperty.Value -notmatch '-----BEGIN PUBLIC KEY-----') {
        throw "update.publicKeyPem debe contener la clave pública de firma."
    }
}

$credentialFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "credentialFile"
$tokenFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "enrollmentTokenFile"
$stateFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "stateFile"
$logFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "logFile"
$lockFileName = Get-ValidatedLocalFileName -Configuration $configuration -PropertyName "lockFile"
$configWriteAttempted = $true
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
Assert-RegularFileOrMissing -Path $installedUpdater
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

if ($updateEnabled) {
    $powershellExecutable = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $quotedUpdaterPath = '"' + $installedUpdater.Replace('"', '""') + '"'
    $quotedInstallPath = '"' + $installPath.Replace('"', '""') + '"'
    $quotedDataPath = '"' + $dataPath.Replace('"', '""') + '"'
    $updateArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedUpdaterPath " +
        "-InstallDirectory $quotedInstallPath -DataDirectory $quotedDataPath"
    $updateAction = New-ScheduledTaskAction `
        -Execute $powershellExecutable `
        -Argument $updateArguments `
        -WorkingDirectory $installPath
    $updateTrigger = New-ScheduledTaskTrigger `
        -Daily `
        -At "03:00" `
        -RandomDelay (New-TimeSpan -Hours 6)
    $updateSettings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
    $updateTask = New-ScheduledTask `
        -Action $updateAction `
        -Trigger $updateTrigger `
        -Principal $principal `
        -Settings $updateSettings `
        -Description "GRF IT Agent: actualización automática firmada por HTTPS."
    Register-ScheduledTask -TaskName $UpdateTaskName -InputObject $updateTask -Force | Out-Null
}
else {
    $existingUpdateTask = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
    if ($null -ne $existingUpdateTask) {
        Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    }
}

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Wait-ScheduledTaskRunning -Name $TaskName -TimeoutSeconds 30 -StableSeconds 5
}

    $transactionCommitted = $true
}
catch {
    $installFailure = $_
    $rollbackErrors = [System.Collections.Generic.List[string]]::new()

    try {
        foreach ($taskToStop in @($UpdateTaskName, $TaskName)) {
            $currentTask = Get-ScheduledTask -TaskName $taskToStop -ErrorAction SilentlyContinue
            if ($null -ne $currentTask) {
                Stop-ScheduledTask -TaskName $taskToStop -ErrorAction SilentlyContinue
                Wait-ScheduledTaskStopped -Name $taskToStop
            }
        }
    }
    catch {
        [void]$rollbackErrors.Add("no se pudieron detener las tareas: $($_.Exception.Message)")
    }

    try {
        Assert-RegularFileOrMissing -Path $installedExecutable
        Assert-RegularFileOrMissing -Path $stagedExecutable
        Assert-RegularFileOrMissing -Path $previousExecutable
        if ($executableSwapAttempted `
            -and (Test-Path -LiteralPath $previousExecutable -PathType Leaf)) {
            if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) {
                if (Test-Path -LiteralPath $stagedExecutable -PathType Leaf) {
                    Remove-Item -LiteralPath $stagedExecutable -Force
                }
                # Restore the exact prior executable atomically. The rejected executable is
                # captured briefly as .new and removed only after the live path is restored.
                [System.IO.File]::Replace(
                    $previousExecutable,
                    $installedExecutable,
                    $stagedExecutable,
                    $true)
                Assert-RegularFileOrMissing -Path $stagedExecutable
                if (Test-Path -LiteralPath $stagedExecutable -PathType Leaf) {
                    Remove-Item -LiteralPath $stagedExecutable -Force
                }
            }
            else {
                Move-Item -LiteralPath $previousExecutable -Destination $installedExecutable
            }
            Set-RestrictedFileAcl -Path $installedExecutable
        }
        elseif ($executableSwapAttempted `
            -and -not $hadInstalledExecutable `
            -and (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
            Set-RestrictedFileAcl -Path $installedExecutable
            Remove-Item -LiteralPath $installedExecutable -Force
        }
        if (Test-Path -LiteralPath $stagedExecutable -PathType Leaf) {
            Assert-RegularFileOrMissing -Path $stagedExecutable
            Remove-Item -LiteralPath $stagedExecutable -Force
        }
    }
    catch {
        [void]$rollbackErrors.Add("no se pudo restaurar el ejecutable: $($_.Exception.Message)")
    }

    try {
        Assert-RegularFileOrMissing -Path $installedUpdater
        Assert-RegularFileOrMissing -Path $stagedUpdater
        Assert-RegularFileOrMissing -Path $previousUpdater
        if ($updaterSwapAttempted `
            -and (Test-Path -LiteralPath $previousUpdater -PathType Leaf)) {
            if (Test-Path -LiteralPath $installedUpdater -PathType Leaf) {
                if (Test-Path -LiteralPath $stagedUpdater -PathType Leaf) {
                    Remove-Item -LiteralPath $stagedUpdater -Force
                }
                [System.IO.File]::Replace(
                    $previousUpdater,
                    $installedUpdater,
                    $stagedUpdater,
                    $true)
                Assert-RegularFileOrMissing -Path $stagedUpdater
                if (Test-Path -LiteralPath $stagedUpdater -PathType Leaf) {
                    Remove-Item -LiteralPath $stagedUpdater -Force
                }
            }
            else {
                Move-Item -LiteralPath $previousUpdater -Destination $installedUpdater
            }
            Set-RestrictedFileAcl -Path $installedUpdater
        }
        elseif ($updaterSwapAttempted `
            -and -not $hadInstalledUpdater `
            -and (Test-Path -LiteralPath $installedUpdater -PathType Leaf)) {
            Set-RestrictedFileAcl -Path $installedUpdater
            Remove-Item -LiteralPath $installedUpdater -Force
        }
        if (Test-Path -LiteralPath $stagedUpdater -PathType Leaf) {
            Assert-RegularFileOrMissing -Path $stagedUpdater
            Remove-Item -LiteralPath $stagedUpdater -Force
        }
    }
    catch {
        [void]$rollbackErrors.Add("no se pudo restaurar el updater: $($_.Exception.Message)")
    }

    if ($configWriteAttempted) {
        try {
            Assert-RegularFileOrMissing -Path $configPath
            if ($configExistedBefore) {
                Write-AtomicUtf8File -Path $configPath -Contents $originalConfigContents
                Set-RestrictedFileAcl -Path $configPath
            }
            # En una primera instalación fallida se conserva config.json junto con el token
            # ya creado; nunca se eliminan configuración ni credenciales durante rollback.
        }
        catch {
            [void]$rollbackErrors.Add("no se pudo restaurar config.json: $($_.Exception.Message)")
        }
    }

    try {
        $currentMainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -ne $existingMainTaskXml) {
            Register-ScheduledTask `
                -TaskName $TaskName `
                -Xml $existingMainTaskXml `
                -Force | Out-Null
        }
        elseif ($null -ne $currentMainTask) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
    }
    catch {
        [void]$rollbackErrors.Add("no se pudo restaurar la tarea principal: $($_.Exception.Message)")
    }

    try {
        $currentUpdateTask = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
        if ($null -ne $existingUpdateTaskXml) {
            Register-ScheduledTask `
                -TaskName $UpdateTaskName `
                -Xml $existingUpdateTaskXml `
                -Force | Out-Null
        }
        elseif ($null -ne $currentUpdateTask) {
            Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
        }
    }
    catch {
        [void]$rollbackErrors.Add("no se pudo restaurar la tarea de actualización: $($_.Exception.Message)")
    }

    if ($mainTaskWasRunning) {
        try {
            Start-ScheduledTask -TaskName $TaskName
            Wait-ScheduledTaskRunning -Name $TaskName -TimeoutSeconds 30 -StableSeconds 3
        }
        catch {
            [void]$rollbackErrors.Add("no se pudo reanudar la tarea principal anterior: $($_.Exception.Message)")
        }
    }
    if ($updateTaskWasRunning) {
        try {
            Start-ScheduledTask -TaskName $UpdateTaskName
        }
        catch {
            [void]$rollbackErrors.Add("no se pudo reanudar la tarea de actualización anterior: $($_.Exception.Message)")
        }
    }

    if ($rollbackErrors.Count -gt 0) {
        throw "La instalación falló: $($installFailure.Exception.Message). " +
            "Rollback incompleto: $($rollbackErrors -join '; ')."
    }
    throw $installFailure
}

if (-not $transactionCommitted) {
    throw "La transacción de instalación no llegó a confirmarse."
}

Write-Host "GRF IT Agent instalado. Tarea: $TaskName"
if ($updateEnabled) {
    Write-Host "Actualización automática habilitada. Tarea: $UpdateTaskName"
}
