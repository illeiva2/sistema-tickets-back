[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [Parameter(Mandatory = $true, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
    [Alias("HostName", "IPAddress")]
    [ValidateNotNullOrEmpty()]
    [string[]]$ComputerName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PackagePath,

    [System.Management.Automation.PSCredential]$Credential,

    [System.Security.SecureString]$EnrollmentToken,

    [switch]$UseSSL,

    [switch]$PreflightOnly,

    [ValidateRange(3, 120)]
    [int]$ConnectionTimeoutSeconds = 10
)

begin {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    $targets = [System.Collections.Generic.List[string]]::new()
    $seenTargets = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)

    function Get-ValidatedPackage {
        param([Parameter(Mandatory = $true)][string]$Path)

        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar)
        $root = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
        if (-not $root.PSIsContainer `
            -or ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "PackagePath debe ser un directorio físico, no un enlace o junction."
        }

        $items = @(Get-ChildItem -LiteralPath $fullPath -Force -Recurse)
        $reparseItem = $items | Where-Object {
            ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        } | Select-Object -First 1
        if ($null -ne $reparseItem) {
            throw "El paquete contiene un enlace o junction y fue rechazado."
        }

        foreach ($requiredName in @(
            "GRF.ITAgent.exe",
            "config.example.json",
            "install.ps1",
            "update-agent.ps1",
            "SHA256SUMS.txt"
        )) {
            if (-not (Test-Path -LiteralPath (Join-Path $fullPath $requiredName) -PathType Leaf)) {
                throw "El paquete no contiene $requiredName. Ejecute publish.ps1 antes de desplegar."
            }
        }

        foreach ($secretName in @("enrollment.token", "credentials.dat")) {
            if ($items.Name -contains $secretName) {
                throw "El paquete contiene $secretName; nunca distribuya credenciales locales."
            }
        }

        $checksumPath = Join-Path $fullPath "SHA256SUMS.txt"
        $checksumLines = @(
            Get-Content -LiteralPath $checksumPath |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        if ($checksumLines.Count -ne 1 `
            -or $checksumLines[0] -notmatch '^([A-Fa-f0-9]{64})\s+GRF\.ITAgent\.exe$') {
            throw "SHA256SUMS.txt no tiene el formato esperado."
        }

        $expectedHash = $Matches[1].ToLowerInvariant()
        $actualHash = (Get-FileHash `
            -LiteralPath (Join-Path $fullPath "GRF.ITAgent.exe") `
            -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "El hash local de GRF.ITAgent.exe no coincide con SHA256SUMS.txt."
        }

        # Se copia solo lo que install.ps1 necesita. Cualquier otro archivo de la carpeta
        # (listas de equipos, notas, restos de pruebas) no debe viajar a cada PC.
        $deployFiles = @(
            foreach ($deployName in @(
                "GRF.ITAgent.exe",
                "install.ps1",
                "update-agent.ps1",
                "config.example.json"
            )) {
                Get-Item -LiteralPath (Join-Path $fullPath $deployName) -Force -ErrorAction Stop
            }
        )

        return [PSCustomObject]@{
            Path = $fullPath
            AgentHash = $expectedHash
            DeployFiles = $deployFiles
        }
    }

    function Assert-ValidTargetName {
        param([Parameter(Mandatory = $true)][string]$Name)

        $trimmed = $Name.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) `
            -or $trimmed.Length -gt 255 `
            -or $trimmed -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
            throw "Destino WinRM inválido: use un hostname, FQDN o IPv4 sin espacios."
        }
        return $trimmed
    }

    function New-DeploymentResult {
        param(
            [Parameter(Mandatory = $true)][string]$Target,
            [Parameter(Mandatory = $true)][string]$Status,
            [Parameter(Mandatory = $true)][string]$Phase,
            [Parameter(Mandatory = $true)][string]$Message,
            [Parameter(Mandatory = $true)][System.Diagnostics.Stopwatch]$Stopwatch,
            [object]$Preflight,
            [string]$Notes
        )

        $hasPreflight = $null -ne $Preflight
        return [PSCustomObject]@{
            ComputerName = $Target
            Status = $Status
            Phase = $Phase
            Message = $Message
            Notes = if ([string]::IsNullOrWhiteSpace($Notes)) { $null } else { $Notes }
            RemoteName = if ($hasPreflight) { $Preflight.ComputerName } else { $null }
            MachineGuid = if ($hasPreflight) { $Preflight.MachineGuid } else { $null }
            InstalledVersion = if ($hasPreflight) { $Preflight.InstalledAgentVersion } else { $null }
            DurationSeconds = [Math]::Round($Stopwatch.Elapsed.TotalSeconds, 1)
        }
    }

    function Get-SafeErrorSummary {
        param([Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord]$ErrorRecord)

        # No serializar InvocationInfo ni argumentos: pueden contener objetos SecureString.
        $message = [string]$ErrorRecord.Exception.Message
        if ([string]::IsNullOrWhiteSpace($message)) {
            return "Error no especificado."
        }
        $singleLine = ($message -replace '[\r\n]+', ' ').Trim()
        if ($singleLine.Length -gt 300) {
            return $singleLine.Substring(0, 300) + "..."
        }
        return $singleLine
    }

    $package = Get-ValidatedPackage -Path $PackagePath

    $baseUri = $null
    if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$baseUri) `
        -or $baseUri.Scheme -ne [Uri]::UriSchemeHttps `
        -or -not [string]::IsNullOrEmpty($baseUri.UserInfo) `
        -or -not [string]::IsNullOrEmpty($baseUri.Query) `
        -or -not [string]::IsNullOrEmpty($baseUri.Fragment)) {
        throw "BaseUrl debe ser una URL HTTPS sin credenciales, query ni fragmento."
    }

    if ($null -eq $Credential) {
        $Credential = Get-Credential -Message (
            "Credencial de Administrador local para los equipos (se solicitará una sola vez)")
    }
    if ($null -eq $Credential) {
        throw "No se proporcionó una credencial administrativa."
    }

    if (-not $PreflightOnly -and -not $WhatIfPreference -and $null -eq $EnrollmentToken) {
        $EnrollmentToken = Read-Host "Token de enrolamiento por lote" -AsSecureString
    }
    if ($null -ne $EnrollmentToken -and $EnrollmentToken.Length -ne 43) {
        throw "El token de enrolamiento debe tener 43 caracteres base64url."
    }

    $sessionOption = New-PSSessionOption `
        -OpenTimeout ($ConnectionTimeoutSeconds * 1000) `
        -OperationTimeout 180000
    $results = [System.Collections.Generic.List[object]]::new()
    # MachineGuid -> preflight del primer equipo que lo informó en esta corrida.
    $machineGuidOwners = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::OrdinalIgnoreCase)
}

process {
    foreach ($candidate in $ComputerName) {
        $target = Assert-ValidTargetName -Name $candidate
        if ($seenTargets.Add($target)) {
            [void]$targets.Add($target)
        }
    }
}

end {
    if ($targets.Count -eq 0) {
        throw "La lista de equipos está vacía."
    }

    foreach ($target in $targets) {
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $session = $null
        $stagingPath = $null
        $preflight = $null
        $notesText = ""
        $phase = "WINRM"
        $installCompleted = $false
        $cleanupError = $null
        $failureMessage = $null

        try {
            Write-Host "[$target] Verificando PowerShell Remoting..."
            try {
                $session = New-PSSession `
                    -ComputerName $target `
                    -Credential $Credential `
                    -Authentication Negotiate `
                    -UseSSL:$UseSSL `
                    -SessionOption $sessionOption `
                    -ErrorAction Stop
            }
            catch {
                $detail = Get-SafeErrorSummary -ErrorRecord $_
                $message = "No se pudo abrir PowerShell Remoting. Este equipo requiere una " +
                    "preparación local inicial si WinRM aún no está habilitado; ejecute " +
                    "Enable-PSRemoting -Force como administrador. Verifique también la " +
                    "credencial y TrustedHosts/HTTPS en la PC de IT. Detalle: $detail"
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status "REMOTING_UNAVAILABLE" `
                    -Phase $phase `
                    -Message $message `
                    -Stopwatch $stopwatch))
                continue
            }

            $phase = "PREFLIGHT"
            $preflight = Invoke-Command -Session $session -ErrorAction Stop -ScriptBlock {
                $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
                $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
                $machineGuid = $null
                try {
                    $machineGuid = [string](Get-ItemProperty `
                        -LiteralPath "HKLM:\SOFTWARE\Microsoft\Cryptography" `
                        -Name "MachineGuid" `
                        -ErrorAction Stop).MachineGuid
                }
                catch {
                    $machineGuid = $null
                }
                $installedExecutable = Join-Path $env:ProgramFiles "GRF\ITAgent\GRF.ITAgent.exe"
                $installedVersion = $null
                if (Test-Path -LiteralPath $installedExecutable -PathType Leaf) {
                    $installedVersion = [string](Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductVersion
                }
                [PSCustomObject]@{
                    IsAdministrator = $principal.IsInRole(
                        [System.Security.Principal.WindowsBuiltInRole]::Administrator)
                    Is64BitOperatingSystem = [Environment]::Is64BitOperatingSystem
                    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
                    OperatingSystem = [Environment]::OSVersion.VersionString
                    ComputerName = $env:COMPUTERNAME
                    MachineGuid = $machineGuid
                    InstalledAgentVersion = $installedVersion
                }
            }

            if (-not $preflight.IsAdministrator) {
                throw "La sesión remota no tiene un token de Administrador local completo."
            }
            if (-not $preflight.Is64BitOperatingSystem) {
                throw "El equipo no es Windows x64."
            }

            # El sistema identifica cada PC por su MachineGuid. Dos equipos clonados de la
            # misma imagen sin Sysprep comparten el valor y, una vez instalados, se pisarían
            # entre sí en el inventario. Se frena antes de tocar el segundo equipo.
            if ([string]::IsNullOrWhiteSpace($preflight.MachineGuid)) {
                throw "No se pudo leer el MachineGuid del equipo; el agente no podría identificarlo."
            }
            if ($machineGuidOwners.ContainsKey($preflight.MachineGuid)) {
                $owner = $machineGuidOwners[$preflight.MachineGuid]
                $sameComputer = [string]$owner.Preflight.ComputerName -eq [string]$preflight.ComputerName
                $status = if ($sameComputer) { "DUPLICATE_TARGET" } else { "DUPLICATE_MACHINE_GUID" }
                $message = if ($sameComputer) {
                    "Es el mismo equipo que '$($owner.Target)' (listado dos veces, por nombre e IP); se omite."
                }
                else {
                    "Comparte el MachineGuid con '$($owner.Target)' ($($owner.Preflight.ComputerName)): " +
                        "parece un clon de la misma imagen. Regenerar la identidad (Sysprep) antes de " +
                        "instalar; si no, ambos equipos aparecen como uno solo en el sistema."
                }
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status $status `
                    -Phase $phase `
                    -Message $message `
                    -Stopwatch $stopwatch `
                    -Preflight $preflight))
                continue
            }
            $machineGuidOwners[$preflight.MachineGuid] = [PSCustomObject]@{
                Target = $target
                Preflight = $preflight
            }

            $notes = [System.Collections.Generic.List[string]]::new()
            if ([string]$preflight.ComputerName -match '[^\x00-\x7F]') {
                $notes.Add("El nombre del equipo tiene ñ o acentos: el agente 0.3 lo acepta, " +
                    "pero WinRM/Kerberos pueden fallar por nombre; conviene apuntar por IP.")
            }
            if (-not [string]::IsNullOrWhiteSpace($preflight.InstalledAgentVersion)) {
                $notes.Add("Ya tiene el agente $($preflight.InstalledAgentVersion): se actualiza " +
                    "en el lugar y conserva su enrolamiento.")
            }
            $notesText = $notes -join " "

            if ($PreflightOnly) {
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status "READY" `
                    -Phase $phase `
                    -Message "WinRM y permisos administrativos disponibles; no se hicieron cambios." `
                    -Stopwatch $stopwatch `
                    -Preflight $preflight `
                    -Notes $notesText))
                continue
            }

            if (-not $PSCmdlet.ShouldProcess(
                $target,
                "Copiar el paquete e instalar GRF IT Agent")) {
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status "WHATIF" `
                    -Phase $phase `
                    -Message "Preflight correcto; la instalación fue omitida por WhatIf/confirmación." `
                    -Stopwatch $stopwatch `
                    -Preflight $preflight `
                    -Notes $notesText))
                continue
            }

            $phase = "STAGING"
            $stageName = [Guid]::NewGuid().ToString("N")
            $stagingPath = Invoke-Command `
                -Session $session `
                -ArgumentList $stageName `
                -ErrorAction Stop `
                -ScriptBlock {
                    param([string]$RequestedStageName)

                    function Set-RestrictedDirectoryAcl {
                        param([Parameter(Mandatory = $true)][string]$Path)

                        $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
                        $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new(
                            "S-1-5-32-544")
                        $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
                        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit `
                            -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
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

                    function Assert-PhysicalAdministrativeDirectory {
                        param([Parameter(Mandatory = $true)][string]$Path)

                        $item = Get-Item -LiteralPath $Path -Force
                        if (-not $item.PSIsContainer `
                            -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                            throw "El staging remoto no es un directorio físico confiable."
                        }
                        $owner = (Get-Acl -LiteralPath $Path).GetOwner(
                            [System.Security.Principal.SecurityIdentifier]).Value
                        if ($owner -notin @("S-1-5-18", "S-1-5-32-544")) {
                            throw "El staging remoto preexistente no tiene owner administrativo."
                        }
                    }

                    if ($RequestedStageName -notmatch '^[a-f0-9]{32}$') {
                        throw "Nombre de staging inválido."
                    }

                    $root = Join-Path $env:ProgramData "GRF-ITAgentDeploy"
                    if (Test-Path -LiteralPath $root) {
                        Assert-PhysicalAdministrativeDirectory -Path $root
                    }
                    else {
                        New-Item -ItemType Directory -Path $root | Out-Null
                    }
                    Set-RestrictedDirectoryAcl -Path $root
                    Assert-PhysicalAdministrativeDirectory -Path $root

                    $stage = Join-Path $root $RequestedStageName
                    if (Test-Path -LiteralPath $stage) {
                        throw "El staging remoto aleatorio ya existe."
                    }
                    New-Item -ItemType Directory -Path $stage | Out-Null
                    Set-RestrictedDirectoryAcl -Path $stage
                    Assert-PhysicalAdministrativeDirectory -Path $stage
                    return $stage
                }

            foreach ($item in $package.DeployFiles) {
                Copy-Item `
                    -LiteralPath $item.FullName `
                    -Destination $stagingPath `
                    -ToSession $session `
                    -Force `
                    -ErrorAction Stop
            }

            $phase = "INSTALL"
            $installResult = Invoke-Command `
                -Session $session `
                -ArgumentList $stagingPath, $baseUri.AbsoluteUri, $EnrollmentToken, $package.AgentHash `
                -ErrorAction Stop `
                -ScriptBlock {
                    param(
                        [string]$Stage,
                        [string]$RemoteBaseUrl,
                        [System.Security.SecureString]$RemoteEnrollmentToken,
                        [string]$ExpectedAgentHash
                    )

                    $stageItem = Get-Item -LiteralPath $Stage -Force
                    if (-not $stageItem.PSIsContainer `
                        -or ($stageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 `
                        -or [System.IO.Path]::GetFileName($Stage) -notmatch '^[a-f0-9]{32}$' `
                        -or -not ([System.IO.Path]::GetDirectoryName($Stage)).Equals(
                            (Join-Path $env:ProgramData "GRF-ITAgentDeploy"),
                            [System.StringComparison]::OrdinalIgnoreCase)) {
                        throw "La ruta de staging remoto dejó de ser confiable."
                    }

                    $reparseItem = Get-ChildItem -LiteralPath $Stage -Force -Recurse |
                        Where-Object {
                            ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
                        } | Select-Object -First 1
                    if ($null -ne $reparseItem) {
                        throw "El paquete remoto contiene un enlace o junction."
                    }

                    $remoteExecutable = Join-Path $Stage "GRF.ITAgent.exe"
                    $installer = Join-Path $Stage "install.ps1"
                    if (-not (Test-Path -LiteralPath $remoteExecutable -PathType Leaf) `
                        -or -not (Test-Path -LiteralPath $installer -PathType Leaf)) {
                        throw "El paquete remoto quedó incompleto."
                    }
                    $remoteHash = (Get-FileHash `
                        -LiteralPath $remoteExecutable `
                        -Algorithm SHA256).Hash.ToLowerInvariant()
                    if ($remoteHash -ne $ExpectedAgentHash) {
                        throw "El hash del agente cambió durante la transferencia."
                    }

                    # Invocar un archivo .ps1 está sujeto a la política de ejecución
                    # del equipo destino (Restricted por defecto en clientes). Bypass
                    # con alcance Process: vale sólo para esta sesión remota y no
                    # persiste ningún cambio en el equipo. Mismo criterio que la tarea
                    # de actualización que registra install.ps1.
                    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

                    $InformationPreference = "SilentlyContinue"
                    & $installer `
                        -BaseUrl $RemoteBaseUrl `
                        -EnrollmentToken $RemoteEnrollmentToken `
                        -Confirm:$false

                    $task = Get-ScheduledTask -TaskName "GRF-IT-Agent" -ErrorAction Stop
                    [PSCustomObject]@{
                        TaskName = $task.TaskName
                        TaskState = [string]$task.State
                    }
                }

            if ($installResult.TaskName -ne "GRF-IT-Agent") {
                throw "La instalación terminó sin registrar la tarea esperada."
            }
            $installCompleted = $true
        }
        catch {
            $failureMessage = Get-SafeErrorSummary -ErrorRecord $_
        }
        finally {
            if ($null -ne $session -and -not [string]::IsNullOrWhiteSpace($stagingPath)) {
                try {
                    Invoke-Command `
                        -Session $session `
                        -ArgumentList $stagingPath `
                        -ErrorAction Stop `
                        -ScriptBlock {
                            param([string]$Stage)

                            function Remove-SafeStagingTree {
                                param([Parameter(Mandatory = $true)][string]$Path)

                                foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
                                    if (($child.Attributes -band `
                                            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                                        throw "Se rechazó limpiar un enlace o junction inesperado."
                                    }
                                    if ($child.PSIsContainer) {
                                        Remove-SafeStagingTree -Path $child.FullName
                                    }
                                    else {
                                        Remove-Item -LiteralPath $child.FullName -Force
                                    }
                                }
                                Remove-Item -LiteralPath $Path -Force
                            }

                            $fullStage = [System.IO.Path]::GetFullPath($Stage).TrimEnd(
                                [System.IO.Path]::DirectorySeparatorChar)
                            $expectedParent = [System.IO.Path]::GetFullPath(
                                (Join-Path $env:ProgramData "GRF-ITAgentDeploy")).TrimEnd(
                                    [System.IO.Path]::DirectorySeparatorChar)
                            if ([System.IO.Path]::GetFileName($fullStage) -notmatch '^[a-f0-9]{32}$' `
                                -or -not ([System.IO.Path]::GetDirectoryName($fullStage)).Equals(
                                    $expectedParent,
                                    [System.StringComparison]::OrdinalIgnoreCase)) {
                                throw "Se rechazó una ruta de limpieza fuera del staging permitido."
                            }

                            if (Test-Path -LiteralPath $fullStage) {
                                $stageItem = Get-Item -LiteralPath $fullStage -Force
                                if (-not $stageItem.PSIsContainer `
                                    -or ($stageItem.Attributes -band `
                                        [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                                    throw "Se rechazó limpiar un staging que no es un directorio físico."
                                }
                                Remove-SafeStagingTree -Path $fullStage
                            }
                        } | Out-Null
                }
                catch {
                    $cleanupError = Get-SafeErrorSummary -ErrorRecord $_
                }
            }

            if ($null -ne $session) {
                Remove-PSSession -Session $session -ErrorAction SilentlyContinue
            }
        }

        if ($null -ne $failureMessage) {
            if ($null -ne $cleanupError) {
                $failureMessage += " Además, el staging protegido requiere limpieza manual: " +
                    $cleanupError
            }
            [void]$results.Add((New-DeploymentResult `
                -Target $target `
                -Status "FAILED" `
                -Phase $phase `
                -Message $failureMessage `
                -Stopwatch $stopwatch `
                -Preflight $preflight `
                -Notes $notesText))
        }
        elseif ($installCompleted) {
            if ($null -eq $cleanupError) {
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status "INSTALLED" `
                    -Phase "COMPLETE" `
                    -Message "Instalación local completada y staging eliminado; el enrolamiento ocurre en segundo plano." `
                    -Stopwatch $stopwatch `
                    -Preflight $preflight `
                    -Notes $notesText))
            }
            else {
                [void]$results.Add((New-DeploymentResult `
                    -Target $target `
                    -Status "INSTALLED_CLEANUP_PENDING" `
                    -Phase "CLEANUP" `
                    -Message "El agente quedó instalado, pero no se pudo limpiar el staging protegido: $cleanupError" `
                    -Stopwatch $stopwatch `
                    -Preflight $preflight `
                    -Notes $notesText))
            }
        }
    }

    Write-Host ""
    Write-Host "Resumen de despliegue:"
    $results |
        Format-Table ComputerName, Status, Phase, RemoteName, InstalledVersion, DurationSeconds -AutoSize |
        Out-Host
    $attention = @($results | Where-Object {
        $_.Status -notin @("INSTALLED", "READY", "WHATIF") -or $null -ne $_.Notes
    })
    if ($attention.Count -gt 0) {
        Write-Host "Requieren atención o tienen observaciones:"
        foreach ($item in $attention) {
            $parts = if ($item.Status -in @("INSTALLED", "READY", "WHATIF")) {
                @($item.Notes)
            }
            else {
                @($item.Message, $item.Notes)
            }
            $detail = @($parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join " "
            Write-Host "  [$($item.ComputerName)] $($item.Status): $detail"
        }
        Write-Host ""
    }
    Write-Output $results.ToArray()
}
