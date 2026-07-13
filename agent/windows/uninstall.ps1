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
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
            -and $rule.IdentityReference.Value -notin $allowedSids) {
            throw "El directorio conserva permisos para una identidad no confiable."
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
        # Fail closed for ambiguous owners on images without the LocalAccounts module.
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

function Secure-ExistingAgentDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$VendorRoot,
        [Parameter(Mandatory = $true)][string]$AgentPath
    )

    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot -AllowMissing
    if (-not (Test-Path -LiteralPath $VendorRoot)) {
        return
    }
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
    Assert-AdministrativeOwner -Path $VendorRoot
    Set-RestrictedAcl -Path $VendorRoot
    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
    Assert-RestrictedDirectoryAcl -Path $VendorRoot

    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath -AllowMissing
    if (Test-Path -LiteralPath $AgentPath) {
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
        Assert-RestrictedDirectoryAcl -Path $AgentPath
        Set-RestrictedAcl -Path $AgentPath
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
        Assert-RestrictedDirectoryAcl -Path $AgentPath
    }
}

function Assert-SecureExistingAgentPaths {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$VendorRoot,
        [Parameter(Mandatory = $true)][string]$AgentPath
    )

    Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot -AllowMissing
    if (Test-Path -LiteralPath $VendorRoot) {
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $VendorRoot
        Assert-RestrictedDirectoryAcl -Path $VendorRoot
    }
    if (Test-Path -LiteralPath $AgentPath) {
        Assert-NoReparseTraversal -TrustedRoot $TrustedRoot -Target $AgentPath
        Assert-RestrictedDirectoryAcl -Path $AgentPath
    }
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
$installVendorRoot = Join-Path $env:ProgramFiles "GRF"
$dataVendorRoot = Join-Path $env:ProgramData "GRF"
$installPath = Get-SafeDirectChildDirectoryPath -Path $InstallDirectory -AllowedParent $installVendorRoot
$dataPath = Get-SafeDirectChildDirectoryPath -Path $DataDirectory -AllowedParent $dataVendorRoot
$dataFileNames = @{
    enrollmentTokenFile = "enrollment.token"
    credentialFile = "credentials.dat"
    stateFile = "state.json"
    logFile = "agent.log"
    lockFile = "agent.lock"
}

if (-not $PSCmdlet.ShouldProcess($installPath, "Desinstalar GRF IT Agent")) {
    return
}

Secure-ExistingAgentDirectory `
    -TrustedRoot $env:ProgramFiles `
    -VendorRoot $installVendorRoot `
    -AgentPath $installPath
Secure-ExistingAgentDirectory `
    -TrustedRoot $env:ProgramData `
    -VendorRoot $dataVendorRoot `
    -AgentPath $dataPath

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $TaskName
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($PurgeData -and (Test-Path -LiteralPath $dataPath -PathType Container)) {
    Assert-SecureExistingAgentPaths `
        -TrustedRoot $env:ProgramData `
        -VendorRoot $dataVendorRoot `
        -AgentPath $dataPath
    $existingConfigPath = Join-Path $dataPath "config.json"
    Assert-RegularFileOrMissing -Path $existingConfigPath
    if (Test-Path -LiteralPath $existingConfigPath -PathType Leaf) {
        Set-RestrictedFileAcl -Path $existingConfigPath
        $existingConfiguration = Get-Content -LiteralPath $existingConfigPath -Raw | ConvertFrom-Json
        foreach ($propertyName in @("enrollmentTokenFile", "credentialFile", "stateFile", "logFile", "lockFile")) {
            $dataFileNames[$propertyName] = Get-ValidatedLocalFileName `
                -Configuration $existingConfiguration `
                -PropertyName $propertyName
        }
    }
}

$executablePath = Join-Path $installPath "GRF.ITAgent.exe"
Assert-SecureExistingAgentPaths `
    -TrustedRoot $env:ProgramFiles `
    -VendorRoot $installVendorRoot `
    -AgentPath $installPath
Assert-RegularFileOrMissing -Path $executablePath
if (Test-Path -LiteralPath $executablePath -PathType Leaf) {
    Set-RestrictedFileAcl -Path $executablePath
    Remove-Item -LiteralPath $executablePath -Force
}
Remove-DirectoryIfEmpty -Path $installPath

if ($PurgeData -and (Test-Path -LiteralPath $dataPath -PathType Container)) {
    Assert-SecureExistingAgentPaths `
        -TrustedRoot $env:ProgramData `
        -VendorRoot $dataVendorRoot `
        -AgentPath $dataPath
    $tokenPath = Join-Path $dataPath $dataFileNames.enrollmentTokenFile
    Assert-RegularFileOrMissing -Path $tokenPath
    Assert-RegularFileOrMissing -Path "$tokenPath.tmp"
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
        Assert-RegularFileOrMissing -Path $path
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Set-RestrictedFileAcl -Path $path
            Remove-Item -LiteralPath $path -Force
        }
    }
    Remove-DirectoryIfEmpty -Path $dataPath
}

Write-Host "GRF IT Agent desinstalado."
if (-not $PurgeData) {
    Write-Host "La configuración y la credencial cifrada se conservaron para una reinstalación."
}
