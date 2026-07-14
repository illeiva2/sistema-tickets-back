[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles "GRF\ITAgent"),
    [string]$DataDirectory = (Join-Path $env:ProgramData "GRF\ITAgent")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$AgentTaskName = "GRF-IT-Agent"
$ExecutableName = "GRF.ITAgent.exe"
$PlanFileName = "update-plan.json"
$TransactionFileName = "update-transaction.json"
$FailedVersionFileName = "failed-version.txt"
$MaximumCandidateBytes = 536870912
$MaximumLogBytes = 524288

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar)
}

function Get-SafeDirectChildDirectoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )

    $fullPath = Get-CanonicalPath -Path $Path
    $parentPath = Get-CanonicalPath -Path $AllowedParent
    $parentPrefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    if ([string]::IsNullOrWhiteSpace($fullPath) `
        -or -not $fullPath.StartsWith($parentPrefix, [System.StringComparison]::OrdinalIgnoreCase) `
        -or -not ([System.IO.Path]::GetDirectoryName($fullPath)).Equals(
            $parentPath,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "El directorio debe ser un hijo directo del directorio GRF esperado."
    }
    return $fullPath
}

function Assert-PhysicalPath {
    param(
        [Parameter(Mandatory = $true)][string]$TrustedRoot,
        [Parameter(Mandatory = $true)][string]$Target,
        [ValidateSet("Directory", "File", "Either")][string]$ExpectedType = "Either",
        [switch]$AllowMissing
    )

    $rootPath = Get-CanonicalPath -Path $TrustedRoot
    $targetPath = Get-CanonicalPath -Path $Target
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
    $segments = @($relative.Split(
        [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar),
        [System.StringSplitOptions]::RemoveEmptyEntries))
    $current = $rootPath
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $current = Join-Path $current $segments[$index]
        $isLast = $index -eq ($segments.Count - 1)
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) {
            if ($AllowMissing) {
                continue
            }
            throw "Falta un componente esperado de la ruta segura."
        }
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Se rechazó una ruta con junction o enlace simbólico."
        }
        if (-not $isLast -and -not $item.PSIsContainer) {
            throw "Un componente intermedio de la ruta no es un directorio."
        }
        if ($isLast -and $ExpectedType -eq "Directory" -and -not $item.PSIsContainer) {
            throw "La ruta esperada no es un directorio."
        }
        if ($isLast -and $ExpectedType -eq "File" -and $item.PSIsContainer) {
            throw "La ruta esperada no es un archivo regular."
        }
    }
}

function Assert-RestrictedAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $allowedSids = @("S-1-5-18", "S-1-5-32-544")
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $allowedSids) {
        throw "El owner de una ruta del agente no es confiable."
    }
    $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
            -and $rule.IdentityReference.Value -notin $allowedSids) {
            throw "Una ruta del agente permite acceso a una identidad no confiable."
        }
    }
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
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $administratorsSid,
        $rights,
        $allow))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-RegularFileOrMissing {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item `
        -and ($item.PSIsContainer `
            -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "Se rechazó un archivo que es directorio, junction o enlace simbólico."
    }
}

function Assert-SystemIdentity {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -ne "S-1-5-18") {
        throw "El actualizador sólo puede ejecutarse como SYSTEM."
    }
}

function Write-AtomicUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Contents
    )

    $temporaryPath = "$Path.tmp"
    Assert-RegularFileOrMissing -Path $Path
    Assert-RegularFileOrMissing -Path $temporaryPath
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Contents)
        $stream = [System.IO.FileStream]::new(
            $temporaryPath,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None,
            4096,
            [System.IO.FileOptions]::WriteThrough)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        Set-RestrictedFileAcl -Path $temporaryPath
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $Path, $null, $true)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $Path)
        }
        Set-RestrictedFileAcl -Path $Path
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Write-UpdateLog {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z0-9_]{1,40}$')][string]$Event,
        [Parameter(Mandatory = $true)][ValidateSet("INFO", "WARN", "ERROR")][string]$Level
    )

    $logPath = Join-Path $script:DataPath "updater.log"
    $archivePath = "$logPath.1"
    foreach ($path in @($logPath, $archivePath)) {
        Assert-RegularFileOrMissing -Path $path
    }
    if ((Test-Path -LiteralPath $logPath -PathType Leaf) `
        -and (Get-Item -LiteralPath $logPath -Force).Length -ge $MaximumLogBytes) {
        if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
            Remove-Item -LiteralPath $archivePath -Force
        }
        Move-Item -LiteralPath $logPath -Destination $archivePath
        Set-RestrictedFileAcl -Path $archivePath
    }
    $line = "{0} {1} {2}`r`n" -f `
        [DateTimeOffset]::UtcNow.ToString("O", [Globalization.CultureInfo]::InvariantCulture), `
        $Level, `
        $Event
    [System.IO.File]::AppendAllText($logPath, $line, [System.Text.UTF8Encoding]::new($false))
    Set-RestrictedFileAcl -Path $logPath
}

function Test-SemVer {
    param([Parameter(Mandatory = $true)][object]$Value)

    return $Value -is [string] `
        -and $Value.Length -le 100 `
        -and $Value -match '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
}

function Test-JsonInteger {
    param([Parameter(Mandatory = $true)][object]$Value)

    return $Value -is [int] -or $Value -is [long]
}

function ConvertTo-StrictUpdatePlan {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedChannel,
        [Parameter(Mandatory = $true)][string]$UpdateRoot,
        [Parameter(Mandatory = $true)][string]$InstalledExecutable
    )

    Assert-PhysicalPath -TrustedRoot $UpdateRoot -Target $Path -ExpectedType File
    Assert-RestrictedAcl -Path $Path
    if ((Get-Item -LiteralPath $Path -Force).Length -gt 16384) {
        throw "El plan excede el tamaño máximo permitido."
    }
    $plan = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $requiredProperties = @(
        "schemaVersion",
        "version",
        "channel",
        "candidatePath",
        "candidateSha256",
        "candidateSize",
        "sourceSha256",
        "sourceSize",
        "publishedAt",
        "preparedAt"
    )
    $actualProperties = @($plan.PSObject.Properties | ForEach-Object Name)
    if ($actualProperties.Count -ne $requiredProperties.Count) {
        throw "El plan de actualización no tiene el esquema exacto."
    }
    foreach ($propertyName in $requiredProperties) {
        if ($propertyName -notin $actualProperties) {
            throw "El plan de actualización no tiene el esquema exacto."
        }
    }
    if (-not (Test-JsonInteger -Value $plan.schemaVersion) -or [long]$plan.schemaVersion -ne 1) {
        throw "schemaVersion no es compatible."
    }
    if (-not (Test-SemVer -Value $plan.version)) {
        throw "La versión candidata no es SemVer válida."
    }
    if ($plan.channel -isnot [string] `
        -or $plan.channel -notin @("stable", "pilot") `
        -or $plan.channel -ne $ExpectedChannel) {
        throw "El canal del plan no coincide con la configuración."
    }
    foreach ($hashProperty in @("candidateSha256", "sourceSha256")) {
        if ($plan.$hashProperty -isnot [string] -or $plan.$hashProperty -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "El plan contiene un SHA-256 inválido."
        }
    }
    foreach ($sizeProperty in @("candidateSize", "sourceSize")) {
        if (-not (Test-JsonInteger -Value $plan.$sizeProperty) `
            -or [long]$plan.$sizeProperty -le 0 `
            -or [long]$plan.$sizeProperty -gt $MaximumCandidateBytes) {
            throw "El plan contiene un tamaño inválido."
        }
    }

    $publishedAt = [DateTimeOffset]::MinValue
    $preparedAt = [DateTimeOffset]::MinValue
    if ($plan.publishedAt -isnot [string] `
        -or -not [DateTimeOffset]::TryParse(
            $plan.publishedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$publishedAt) `
        -or $plan.preparedAt -isnot [string] `
        -or -not [DateTimeOffset]::TryParse(
            $plan.preparedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$preparedAt) `
        -or $publishedAt -gt $preparedAt `
        -or $preparedAt -gt [DateTimeOffset]::UtcNow.AddDays(1)) {
        throw "El plan contiene timestamps inválidos."
    }

    if ($plan.candidatePath -isnot [string] -or [string]::IsNullOrWhiteSpace($plan.candidatePath)) {
        throw "candidatePath es inválido."
    }
    $candidatePath = Get-CanonicalPath -Path $plan.candidatePath
    $stagingPath = Join-Path $UpdateRoot "staging"
    Assert-PhysicalPath -TrustedRoot $UpdateRoot -Target $stagingPath -ExpectedType Directory
    Assert-RestrictedAcl -Path $stagingPath
    $expectedCandidatePath = Get-CanonicalPath -Path (Join-Path `
        $stagingPath `
        ("GRF.ITAgent-{0}.exe" -f [string]$plan.version))
    if (-not $candidatePath.Equals(
        $expectedCandidatePath,
        [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "candidatePath no coincide con el staging canónico de la versión."
    }
    Assert-PhysicalPath -TrustedRoot $UpdateRoot -Target $candidatePath -ExpectedType File
    Assert-RestrictedAcl -Path $candidatePath
    $candidateItem = Get-Item -LiteralPath $candidatePath -Force
    if ($candidateItem.Length -ne [long]$plan.candidateSize `
        -or (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash `
            -ne $plan.candidateSha256) {
        throw "El candidato no coincide con el plan firmado."
    }

    # sourceSha256/sourceSize identify the signed release artifact (ZIP), which the C#
    # preparer already verified before extracting this candidate. They are validated above
    # as strict plan fields; candidateSha256/candidateSize protect the executable swap.
    Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $InstalledExecutable -ExpectedType File
    Assert-RestrictedAcl -Path $InstalledExecutable

    return [PSCustomObject]@{
        Version = [string]$plan.version
        Channel = [string]$plan.channel
        CandidatePath = $candidatePath
        CandidateSha256 = ([string]$plan.candidateSha256).ToLowerInvariant()
        CandidateSize = [long]$plan.candidateSize
    }
}

function Wait-ScheduledTaskStopped {
    param([Parameter(Mandatory = $true)][string]$Name)

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($null -eq $task -or [string]$task.State -ne "Running") {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "La tarea principal no se detuvo a tiempo."
}

function Wait-AgentRunning {
    param([Parameter(Mandatory = $true)][string]$Name)

    $running = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($null -ne $task -and [string]$task.State -eq "Running") {
            $running = $true
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $running) {
        throw "La tarea principal no alcanzó el estado Running."
    }

    # A process that only reaches Running for a moment is not a healthy update. Require a
    # continuous stability window before deleting the rollback copy or transaction marker.
    for ($second = 0; $second -lt 15; $second++) {
        Start-Sleep -Seconds 1
        $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($null -eq $task -or [string]$task.State -ne "Running") {
            throw "La tarea principal no permaneció Running durante la ventana de salud."
        }
    }
}

function Remove-SafeUpdateFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UpdateRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-PhysicalPath -TrustedRoot $UpdateRoot -Target $Path -ExpectedType File
    Assert-RestrictedAcl -Path $Path
    Remove-Item -LiteralPath $Path -Force
}

function Remove-SafeInstallFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $Path -ExpectedType File
    Assert-RestrictedAcl -Path $Path
    Remove-Item -LiteralPath $Path -Force
}

function Get-ValidatedAgentVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $validationOutput = @(& $Executable --validate-install --config $ConfigPath 2>$null)
    $validationExitCode = $LASTEXITCODE
    if ($validationExitCode -ne 0 -or $validationOutput.Count -ne 1) {
        return $null
    }
    $version = [string]$validationOutput[0]
    if (-not $version.Equals($version.Trim(), [System.StringComparison]::Ordinal) `
        -or -not (Test-SemVer -Value $version)) {
        return $null
    }
    return $version
}

function Test-AgentFileIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][long]$ExpectedSize
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $Path -ExpectedType File
    Assert-RestrictedAcl -Path $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Length -ne $ExpectedSize `
        -or -not (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Equals(
            $ExpectedSha256,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return $true
}

function Test-AgentIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][long]$ExpectedSize,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    if (-not (Test-AgentFileIdentity `
        -Path $Path `
        -ExpectedSha256 $ExpectedSha256 `
        -ExpectedSize $ExpectedSize)) {
        return $false
    }
    $actualVersion = Get-ValidatedAgentVersion -Executable $Path -ConfigPath $ConfigPath
    return $null -ne $actualVersion `
        -and $actualVersion.Equals($ExpectedVersion, [System.StringComparison]::Ordinal)
}

function ConvertTo-StrictUpdateTransaction {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$UpdateRoot
    )

    Assert-PhysicalPath -TrustedRoot $UpdateRoot -Target $Path -ExpectedType File
    Assert-RestrictedAcl -Path $Path
    if ((Get-Item -LiteralPath $Path -Force).Length -gt 8192) {
        throw "El marcador de transacción excede el tamaño permitido."
    }
    $transaction = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $requiredProperties = @(
        "schemaVersion",
        "targetVersion",
        "targetSha256",
        "targetSize",
        "previousVersion",
        "previousSha256",
        "previousSize",
        "startedAt"
    )
    $actualProperties = @($transaction.PSObject.Properties | ForEach-Object Name)
    if ($actualProperties.Count -ne $requiredProperties.Count) {
        throw "El marcador de transacción no tiene el esquema exacto."
    }
    foreach ($propertyName in $requiredProperties) {
        if ($propertyName -notin $actualProperties) {
            throw "El marcador de transacción no tiene el esquema exacto."
        }
    }
    if (-not (Test-JsonInteger -Value $transaction.schemaVersion) `
        -or [long]$transaction.schemaVersion -ne 1 `
        -or -not (Test-SemVer -Value $transaction.targetVersion) `
        -or -not (Test-SemVer -Value $transaction.previousVersion)) {
        throw "El marcador de transacción contiene versiones inválidas."
    }
    foreach ($hashProperty in @("targetSha256", "previousSha256")) {
        if ($transaction.$hashProperty -isnot [string] `
            -or $transaction.$hashProperty -notmatch '^[A-Fa-f0-9]{64}$') {
            throw "El marcador de transacción contiene un SHA-256 inválido."
        }
    }
    foreach ($sizeProperty in @("targetSize", "previousSize")) {
        if (-not (Test-JsonInteger -Value $transaction.$sizeProperty) `
            -or [long]$transaction.$sizeProperty -le 0 `
            -or [long]$transaction.$sizeProperty -gt $MaximumCandidateBytes) {
            throw "El marcador de transacción contiene un tamaño inválido."
        }
    }
    $startedAt = [DateTimeOffset]::MinValue
    if ($transaction.startedAt -isnot [string] `
        -or -not [DateTimeOffset]::TryParse(
            $transaction.startedAt,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$startedAt) `
        -or $startedAt -gt [DateTimeOffset]::UtcNow.AddDays(1)) {
        throw "El marcador de transacción contiene un timestamp inválido."
    }

    return [PSCustomObject]@{
        TargetVersion = [string]$transaction.targetVersion
        TargetSha256 = ([string]$transaction.targetSha256).ToLowerInvariant()
        TargetSize = [long]$transaction.targetSize
        PreviousVersion = [string]$transaction.previousVersion
        PreviousSha256 = ([string]$transaction.previousSha256).ToLowerInvariant()
        PreviousSize = [long]$transaction.previousSize
    }
}

function Start-AndVerifyAgentTask {
    if ($null -eq (Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue)) {
        throw "No existe la tarea principal del agente."
    }
    $task = Get-ScheduledTask -TaskName $AgentTaskName
    if ([string]$task.State -ne "Running") {
        Start-ScheduledTask -TaskName $AgentTaskName
    }
    Wait-AgentRunning -Name $AgentTaskName
}

function Complete-UpdateTransaction {
    param(
        [Parameter(Mandatory = $true)][object]$Transaction,
        [Parameter(Mandatory = $true)][string]$TransactionPath,
        [Parameter(Mandatory = $true)][string]$UpdateRoot,
        [Parameter(Mandatory = $true)][string]$InstalledExecutable
    )

    foreach ($installFile in @(
        "$InstalledExecutable.new",
        "$InstalledExecutable.previous",
        "$InstalledExecutable.rejected")) {
        Remove-SafeInstallFile -Path $installFile
    }
    $candidatePath = Join-Path `
        (Join-Path $UpdateRoot "staging") `
        ("GRF.ITAgent-{0}.exe" -f $Transaction.TargetVersion)
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
        Remove-SafeUpdateFile -Path $candidatePath -UpdateRoot $UpdateRoot
    }
    $publishedPlanPath = Join-Path $UpdateRoot $PlanFileName
    if (Test-Path -LiteralPath $publishedPlanPath -PathType Leaf) {
        Remove-SafeUpdateFile -Path $publishedPlanPath -UpdateRoot $UpdateRoot
    }
    # Remove the transaction publication point last. A crash earlier remains recoverable.
    Remove-SafeUpdateFile -Path $TransactionPath -UpdateRoot $UpdateRoot
}

function Restore-PreviousAgent {
    param(
        [Parameter(Mandatory = $true)][object]$Transaction,
        [Parameter(Mandatory = $true)][string]$InstalledExecutable,
        [Parameter(Mandatory = $true)][string]$PreviousPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    # File.Replace deliberately gives the backup a non-.exe suffix. Windows refuses to
    # launch it, so authenticate the protected backup by its recorded hash and size here;
    # its exact version is checked immediately after it is restored to the .exe path.
    if (-not (Test-AgentFileIdentity `
        -Path $PreviousPath `
        -ExpectedSha256 $Transaction.PreviousSha256 `
        -ExpectedSize $Transaction.PreviousSize)) {
        throw "La copia rollback no coincide con la transacción protegida."
    }

    Stop-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $AgentTaskName
    $rejectedPath = "$InstalledExecutable.rejected"
    Remove-SafeInstallFile -Path $rejectedPath
    if (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf) {
        Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $InstalledExecutable -ExpectedType File
        Assert-RestrictedAcl -Path $InstalledExecutable
        [System.IO.File]::Replace($PreviousPath, $InstalledExecutable, $rejectedPath, $true)
        Set-RestrictedFileAcl -Path $InstalledExecutable
        Remove-SafeInstallFile -Path $rejectedPath
    }
    else {
        Assert-PhysicalPath `
            -TrustedRoot $script:InstallPath `
            -Target $InstalledExecutable `
            -ExpectedType File `
            -AllowMissing
        [System.IO.File]::Move($PreviousPath, $InstalledExecutable)
        Set-RestrictedFileAcl -Path $InstalledExecutable
    }
    if (-not (Test-AgentIdentity `
        -Path $InstalledExecutable `
        -ExpectedVersion $Transaction.PreviousVersion `
        -ExpectedSha256 $Transaction.PreviousSha256 `
        -ExpectedSize $Transaction.PreviousSize `
        -ConfigPath $ConfigPath)) {
        throw "El rollback atómico no restauró el agente esperado."
    }
    Start-AndVerifyAgentTask
}

function Resolve-InterruptedUpdate {
    param(
        [Parameter(Mandatory = $true)][string]$UpdateRoot,
        [Parameter(Mandatory = $true)][string]$InstalledExecutable,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $transactionPath = Join-Path $UpdateRoot $TransactionFileName
    if (-not (Test-Path -LiteralPath $transactionPath -PathType Leaf)) {
        return $null
    }
    $transaction = ConvertTo-StrictUpdateTransaction -Path $transactionPath -UpdateRoot $UpdateRoot
    $previousPath = "$InstalledExecutable.previous"
    $currentIsTarget = Test-AgentIdentity `
        -Path $InstalledExecutable `
        -ExpectedVersion $transaction.TargetVersion `
        -ExpectedSha256 $transaction.TargetSha256 `
        -ExpectedSize $transaction.TargetSize `
        -ConfigPath $ConfigPath
    $currentIsPrevious = Test-AgentIdentity `
        -Path $InstalledExecutable `
        -ExpectedVersion $transaction.PreviousVersion `
        -ExpectedSha256 $transaction.PreviousSha256 `
        -ExpectedSize $transaction.PreviousSize `
        -ConfigPath $ConfigPath
    $backupIsPrevious = Test-AgentFileIdentity `
        -Path $previousPath `
        -ExpectedSha256 $transaction.PreviousSha256 `
        -ExpectedSize $transaction.PreviousSize

    if ($currentIsTarget) {
        try {
            Start-AndVerifyAgentTask
            $failedVersionPath = Join-Path $UpdateRoot $FailedVersionFileName
            if (Test-Path -LiteralPath $failedVersionPath -PathType Leaf) {
                Remove-SafeUpdateFile -Path $failedVersionPath -UpdateRoot $UpdateRoot
            }
            Complete-UpdateTransaction `
                -Transaction $transaction `
                -TransactionPath $transactionPath `
                -UpdateRoot $UpdateRoot `
                -InstalledExecutable $InstalledExecutable
            return "UPDATE_RECOVERY_COMPLETED"
        }
        catch {
            if (-not $backupIsPrevious) {
                throw
            }
            Restore-PreviousAgent `
                -Transaction $transaction `
                -InstalledExecutable $InstalledExecutable `
                -PreviousPath $previousPath `
                -ConfigPath $ConfigPath
            $failedVersionPath = Join-Path $UpdateRoot $FailedVersionFileName
            Write-AtomicUtf8File -Path $failedVersionPath -Contents ($transaction.TargetVersion + "`r`n")
            Complete-UpdateTransaction `
                -Transaction $transaction `
                -TransactionPath $transactionPath `
                -UpdateRoot $UpdateRoot `
                -InstalledExecutable $InstalledExecutable
            return "UPDATE_RECOVERY_ROLLED_BACK"
        }
    }

    if ($currentIsPrevious) {
        # The marker was durable but File.Replace had not committed, or rollback already did.
        Start-AndVerifyAgentTask
        Complete-UpdateTransaction `
            -Transaction $transaction `
            -TransactionPath $transactionPath `
            -UpdateRoot $UpdateRoot `
            -InstalledExecutable $InstalledExecutable
        return "UPDATE_RECOVERY_ABORTED"
    }

    if ($backupIsPrevious) {
        Restore-PreviousAgent `
            -Transaction $transaction `
            -InstalledExecutable $InstalledExecutable `
            -PreviousPath $previousPath `
            -ConfigPath $ConfigPath
        $failedVersionPath = Join-Path $UpdateRoot $FailedVersionFileName
        Write-AtomicUtf8File -Path $failedVersionPath -Contents ($transaction.TargetVersion + "`r`n")
        Complete-UpdateTransaction `
            -Transaction $transaction `
            -TransactionPath $transactionPath `
            -UpdateRoot $UpdateRoot `
            -InstalledExecutable $InstalledExecutable
        return "UPDATE_RECOVERY_ROLLED_BACK"
    }

    throw "La transacción interrumpida no contiene una copia actual o rollback confiable."
}

$script:InstallPath = $null
$script:DataPath = $null
$preparedPlan = $null
$planPath = $null
$updateRoot = $null
$newPath = $null
$previousPath = $null
$transactionPath = $null
$installedExecutable = $null

try {
    Assert-SystemIdentity
    $installVendorRoot = Join-Path $env:ProgramFiles "GRF"
    $dataVendorRoot = Join-Path $env:ProgramData "GRF"
    $script:InstallPath = Get-SafeDirectChildDirectoryPath `
        -Path $InstallDirectory `
        -AllowedParent $installVendorRoot
    $script:DataPath = Get-SafeDirectChildDirectoryPath `
        -Path $DataDirectory `
        -AllowedParent $dataVendorRoot
    foreach ($directory in @($installVendorRoot, $dataVendorRoot, $script:InstallPath, $script:DataPath)) {
        $trustedRoot = if ($directory.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase)) {
            $env:ProgramFiles
        }
        else {
            $env:ProgramData
        }
        Assert-PhysicalPath -TrustedRoot $trustedRoot -Target $directory -ExpectedType Directory
        Assert-RestrictedAcl -Path $directory
    }

    $installedExecutable = Join-Path $script:InstallPath $ExecutableName
    $configPath = Join-Path $script:DataPath "config.json"
    Assert-PhysicalPath `
        -TrustedRoot $script:InstallPath `
        -Target $installedExecutable `
        -ExpectedType File `
        -AllowMissing
    Assert-RegularFileOrMissing -Path $installedExecutable
    Assert-PhysicalPath -TrustedRoot $script:DataPath -Target $configPath -ExpectedType File
    Assert-RestrictedAcl -Path $configPath

    $updateRoot = Join-Path $script:DataPath "updates"
    if (Test-Path -LiteralPath $updateRoot) {
        Assert-PhysicalPath -TrustedRoot $script:DataPath -Target $updateRoot -ExpectedType Directory
        Assert-RestrictedAcl -Path $updateRoot
        $transactionPath = Join-Path $updateRoot $TransactionFileName
        if (Test-Path -LiteralPath $transactionPath -PathType Leaf) {
            $recoveryEvent = Resolve-InterruptedUpdate `
                -UpdateRoot $updateRoot `
                -InstalledExecutable $installedExecutable `
                -ConfigPath $configPath
            if ($null -ne $recoveryEvent) {
                Write-UpdateLog -Event $recoveryEvent -Level "WARN"
            }
        }
    }

    Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $installedExecutable -ExpectedType File
    Assert-RestrictedAcl -Path $installedExecutable

    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $updateProperty = $configuration.PSObject.Properties["update"]
    if ($null -eq $updateProperty `
        -or $null -eq $updateProperty.Value `
        -or $updateProperty.Value.enabled -isnot [bool] `
        -or -not $updateProperty.Value.enabled) {
        Write-UpdateLog -Event "UPDATE_DISABLED" -Level "INFO"
        exit 0
    }
    $channel = $updateProperty.Value.channel
    if ($channel -isnot [string] -or $channel -notin @("stable", "pilot")) {
        throw "El canal de actualización es inválido."
    }

    Write-UpdateLog -Event "CHECK_STARTED" -Level "INFO"

    $null = & $installedExecutable --prepare-update --config $configPath
    $prepareExitCode = $LASTEXITCODE
    if ($prepareExitCode -eq 3) {
        Write-UpdateLog -Event "MANIFEST_INCOMPATIBLE" -Level "WARN"
        exit 0
    }
    if ($prepareExitCode -ne 0) {
        throw "El agente no pudo preparar la actualización."
    }
    if (-not (Test-Path -LiteralPath $updateRoot -PathType Container)) {
        Write-UpdateLog -Event "NO_UPDATE" -Level "INFO"
        exit 0
    }
    Assert-PhysicalPath -TrustedRoot $script:DataPath -Target $updateRoot -ExpectedType Directory
    Assert-RestrictedAcl -Path $updateRoot
    $planPath = Join-Path $updateRoot $PlanFileName
    if (-not (Test-Path -LiteralPath $planPath -PathType Leaf)) {
        Write-UpdateLog -Event "NO_UPDATE" -Level "INFO"
        exit 0
    }

    $preparedPlan = ConvertTo-StrictUpdatePlan `
        -Path $planPath `
        -ExpectedChannel $channel `
        -UpdateRoot $updateRoot `
        -InstalledExecutable $installedExecutable
    $failedVersionPath = Join-Path $updateRoot $FailedVersionFileName
    Assert-RegularFileOrMissing -Path $failedVersionPath
    if (Test-Path -LiteralPath $failedVersionPath -PathType Leaf) {
        Assert-PhysicalPath -TrustedRoot $updateRoot -Target $failedVersionPath -ExpectedType File
        Assert-RestrictedAcl -Path $failedVersionPath
        $failedVersion = (Get-Content -LiteralPath $failedVersionPath -Raw).Trim()
        if (-not (Test-SemVer -Value $failedVersion)) {
            throw "El sentinel de versión fallida es inválido."
        }
        if ($failedVersion -eq $preparedPlan.Version) {
            Write-UpdateLog -Event "FAILED_VERSION_SKIPPED" -Level "WARN"
            exit 0
        }
    }

    $candidateVersion = Get-ValidatedAgentVersion `
        -Executable $preparedPlan.CandidatePath `
        -ConfigPath $configPath
    if ($null -eq $candidateVersion `
        -or -not $candidateVersion.Equals(
            $preparedPlan.Version,
            [System.StringComparison]::Ordinal)) {
        Write-AtomicUtf8File -Path $failedVersionPath -Contents ($preparedPlan.Version + "`r`n")
        throw "El candidato no reportó exactamente la versión firmada del plan."
    }

    $newPath = "$installedExecutable.new"
    $previousPath = "$installedExecutable.previous"
    $rejectedPath = "$installedExecutable.rejected"
    foreach ($path in @($newPath, $previousPath, $rejectedPath)) {
        Assert-PhysicalPath `
            -TrustedRoot $script:InstallPath `
            -Target $path `
            -ExpectedType File `
            -AllowMissing
        Assert-RegularFileOrMissing -Path $path
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Assert-RestrictedAcl -Path $path
            Remove-Item -LiteralPath $path -Force
        }
    }
    Copy-Item -LiteralPath $preparedPlan.CandidatePath -Destination $newPath
    Set-RestrictedFileAcl -Path $newPath
    if ((Get-Item -LiteralPath $newPath -Force).Length -ne $preparedPlan.CandidateSize `
        -or -not (Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash.Equals(
            $preparedPlan.CandidateSha256,
            [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "La copia local del candidato no coincide con el plan."
    }

    if ($null -eq (Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue)) {
        throw "No existe la tarea principal del agente."
    }
    $previousVersion = Get-ValidatedAgentVersion `
        -Executable $installedExecutable `
        -ConfigPath $configPath
    if ($null -eq $previousVersion) {
        throw "El agente actual no pasó la validación previa a la transacción."
    }
    $previousItem = Get-Item -LiteralPath $installedExecutable -Force
    $previousSha256 = (Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $transactionPath = Join-Path $updateRoot $TransactionFileName
    Assert-RegularFileOrMissing -Path $transactionPath
    if (Test-Path -LiteralPath $transactionPath) {
        throw "Ya existe una transacción de update sin resolver."
    }
    $transactionJson = [ordered]@{
        schemaVersion = 1
        targetVersion = $preparedPlan.Version
        targetSha256 = $preparedPlan.CandidateSha256
        targetSize = $preparedPlan.CandidateSize
        previousVersion = $previousVersion
        previousSha256 = $previousSha256
        previousSize = [long]$previousItem.Length
        startedAt = [DateTimeOffset]::UtcNow.ToString(
            "O",
            [Globalization.CultureInfo]::InvariantCulture)
    } | ConvertTo-Json -Compress
    Write-AtomicUtf8File -Path $transactionPath -Contents $transactionJson

    Stop-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
    Wait-ScheduledTaskStopped -Name $AgentTaskName
    # Same-directory File.Replace is one atomic filesystem operation: current is always
    # either the old complete EXE or the new complete EXE, and previous receives the old one.
    [System.IO.File]::Replace($newPath, $installedExecutable, $previousPath, $true)
    Set-RestrictedFileAcl -Path $installedExecutable
    if (-not (Test-AgentIdentity `
        -Path $installedExecutable `
        -ExpectedVersion $preparedPlan.Version `
        -ExpectedSha256 $preparedPlan.CandidateSha256 `
        -ExpectedSize $preparedPlan.CandidateSize `
        -ConfigPath $configPath)) {
        throw "El ejecutable instalado no reportó exactamente la versión objetivo."
    }
    Start-AndVerifyAgentTask

    if (Test-Path -LiteralPath $failedVersionPath -PathType Leaf) {
        Remove-SafeUpdateFile -Path $failedVersionPath -UpdateRoot $updateRoot
    }
    $transaction = ConvertTo-StrictUpdateTransaction `
        -Path $transactionPath `
        -UpdateRoot $updateRoot
    Complete-UpdateTransaction `
        -Transaction $transaction `
        -TransactionPath $transactionPath `
        -UpdateRoot $updateRoot `
        -InstalledExecutable $installedExecutable
    Write-UpdateLog -Event "UPDATE_SUCCEEDED" -Level "INFO"
    exit 0
}
catch {
    $failureType = $_.Exception.GetType().Name.ToUpperInvariant()
    $failureEvent = "UPDATE_FAILED"
    if ($failureType -match '^[A-Z0-9_]{1,24}$') {
        $failureEvent = "FAILED_$failureType"
    }

    if ($null -ne $preparedPlan -and $null -ne $updateRoot) {
        try {
            $failedVersionPath = Join-Path $updateRoot $FailedVersionFileName
            Write-AtomicUtf8File -Path $failedVersionPath -Contents ($preparedPlan.Version + "`r`n")
        }
        catch {
            $failureEvent = "FAILED_SENTINEL_ERROR"
        }
    }

    $recoveredAsTarget = $false
    if ($null -ne $transactionPath `
        -and $null -ne $updateRoot `
        -and (Test-Path -LiteralPath $transactionPath -PathType Leaf)) {
        try {
            $recoveryEvent = Resolve-InterruptedUpdate `
                -UpdateRoot $updateRoot `
                -InstalledExecutable $installedExecutable `
                -ConfigPath $configPath
            if ($recoveryEvent -eq "UPDATE_RECOVERY_COMPLETED") {
                $failureEvent = $recoveryEvent
                $recoveredAsTarget = $true
            }
            elseif ($recoveryEvent -eq "UPDATE_RECOVERY_ROLLED_BACK") {
                $failureEvent = "UPDATE_ROLLED_BACK"
            }
            else {
                $failureEvent = "UPDATE_ABORTED_RESTARTED"
            }
        }
        catch {
            $failureEvent = "ROLLBACK_FAILED"
        }
    }

    if ($null -ne $script:DataPath -and (Test-Path -LiteralPath $script:DataPath -PathType Container)) {
        try {
            $failureLevel = if ($recoveredAsTarget) { "WARN" } else { "ERROR" }
            Write-UpdateLog -Event $failureEvent -Level $failureLevel
        }
        catch {
            # Scheduled Task LastTaskResult still reports the failure if protected logging fails.
        }
    }
    if ($recoveredAsTarget) {
        exit 0
    }
    exit 1
}
finally {
    $hasPendingTransaction = $null -ne $transactionPath `
        -and (Test-Path -LiteralPath $transactionPath -PathType Leaf)
    if (-not $hasPendingTransaction `
        -and $null -ne $newPath `
        -and (Test-Path -LiteralPath $newPath -PathType Leaf)) {
        try {
            Assert-PhysicalPath -TrustedRoot $script:InstallPath -Target $newPath -ExpectedType File
            Assert-RestrictedAcl -Path $newPath
            Remove-Item -LiteralPath $newPath -Force
        }
        catch {
            # Fail closed: a path that stopped being trustworthy is left for manual inspection.
        }
    }
}
