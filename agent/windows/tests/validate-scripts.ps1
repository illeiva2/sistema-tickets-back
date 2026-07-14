[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$agentRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$requirements = @{
    "install.ps1" = @(
        "Get-SafeDirectChildDirectoryPath",
        "Assert-NoReparseTraversal",
        "Assert-AdministrativeOwner",
        "Assert-RestrictedDirectoryAcl",
        "Assert-RegularFileOrMissing",
        "Initialize-SecureAgentDirectory",
        "Assert-SecureAgentPaths",
        "Wait-ScheduledTaskRunning"
    )
    "uninstall.ps1" = @(
        "Get-SafeDirectChildDirectoryPath",
        "Assert-NoReparseTraversal",
        "Assert-AdministrativeOwner",
        "Assert-RestrictedDirectoryAcl",
        "Assert-RegularFileOrMissing",
        "Secure-ExistingAgentDirectory",
        "Assert-SecureExistingAgentPaths",
        "Remove-BoundedPhysicalTree"
    )
    "update-agent.ps1" = @(
        "Get-SafeDirectChildDirectoryPath",
        "Assert-PhysicalPath",
        "Assert-RestrictedAcl",
        "Assert-RegularFileOrMissing",
        "Assert-SystemIdentity",
        "ConvertTo-StrictUpdatePlan",
        "ConvertTo-StrictUpdateTransaction",
        "Resolve-InterruptedUpdate",
        "Get-ValidatedAgentVersion",
        "Test-AgentFileIdentity",
        "Test-AgentIdentity",
        "Wait-ScheduledTaskStopped",
        "Wait-AgentRunning",
        "Remove-SafeUpdateFile"
    )
    "deploy-remotely.ps1" = @(
        "Get-ValidatedPackage",
        "Assert-ValidTargetName",
        "New-DeploymentResult",
        "Get-SafeErrorSummary",
        "Set-RestrictedDirectoryAcl",
        "Assert-PhysicalAdministrativeDirectory",
        "Remove-SafeStagingTree"
    )
}

foreach ($entry in $requirements.GetEnumerator()) {
    $path = Join-Path $agentRoot $entry.Key
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $path,
        [ref]$tokens,
        [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) {
        throw "$($entry.Key) tiene errores de sintaxis."
    }

    $functions = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    }, $true) | ForEach-Object Name)
    $commands = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst]
    }, $true) | ForEach-Object { $_.GetCommandName() })

    foreach ($requiredFunction in $entry.Value) {
        if ($requiredFunction -notin $functions) {
            throw "$($entry.Key) no define $requiredFunction."
        }
        if ($requiredFunction -notin $commands) {
            throw "$($entry.Key) define pero no invoca $requiredFunction."
        }
    }

    $source = [System.IO.File]::ReadAllText($path)
    if ($source -notmatch "ReparsePoint") {
        throw "$($entry.Key) perdió controles contra reparse points."
    }
    if ($entry.Key -ne "deploy-remotely.ps1" `
        -and ($source -notmatch 'S-1-5-18' -or $source -notmatch 'S-1-5-32-544')) {
        throw "$($entry.Key) perdió controles de reparse o ACL esperados."
    }
    if ($source -match 'Remove-Item[^\r\n]*-Recurse') {
        throw "$($entry.Key) no puede borrar recursivamente."
    }

    Write-Output "PASS seguridad estática $($entry.Key)"
}

$deployPath = Join-Path $agentRoot "deploy-remotely.ps1"
$deploySource = [System.IO.File]::ReadAllText($deployPath)
foreach ($requiredPattern in @(
    'SupportsShouldProcess\s*=\s*\$true',
    '\[System\.Security\.SecureString\]\$EnrollmentToken',
    'Read-Host\s+"Token de enrolamiento por lote"\s+-AsSecureString',
    'Get-Credential',
    'New-PSSession',
    'Copy-Item[\s\S]{0,300}-ToSession',
    'Invoke-Command',
    'Remove-PSSession',
    'SHA256SUMS\.txt',
    'S-1-5-18',
    'S-1-5-32-544',
    'REMOTING_UNAVAILABLE',
    'Enable-PSRemoting -Force'
)) {
    if ($deploySource -notmatch $requiredPattern) {
        throw "deploy-remotely.ps1 perdió el control esperado: $requiredPattern"
    }
}

foreach ($forbiddenPattern in @(
    'SecureStringToBSTR',
    'PtrToString',
    'NetworkCredential',
    'ConvertFrom-SecureString',
    'ConvertTo-SecureString[^\r\n]*-AsPlainText',
    'Remove-Item[^\r\n]*-Recurse',
    '(Write-Host|Write-Output|Write-Verbose|Write-Information|Write-Warning)[^\r\n]*EnrollmentToken'
)) {
    if ($deploySource -match $forbiddenPattern) {
        throw "deploy-remotely.ps1 expone secretos o usa una limpieza insegura: $forbiddenPattern"
    }
}

Write-Output "PASS despliegue remoto sin secretos en argumentos/logs"

$updaterPath = Join-Path $agentRoot "update-agent.ps1"
$updaterSource = [System.IO.File]::ReadAllText($updaterPath)
foreach ($requiredPattern in @(
    '--prepare-update',
    '--validate-install',
    'update-plan\.json',
    'update-transaction\.json',
    'failed-version\.txt',
    'schemaVersion',
    'candidateSha256',
    'sourceSha256',
    'Get-FileHash[\s\S]{0,150}-Algorithm SHA256',
    'installedExecutable\.new',
    'installedExecutable\.previous',
    'backupIsPrevious\s*=\s*Test-AgentFileIdentity',
    'Test-AgentFileIdentity[\s\S]{0,220}-Path\s+\$PreviousPath',
    '\[System\.IO\.File\]::Replace\(\$newPath,\s*\$installedExecutable,\s*\$previousPath',
    'candidateVersion\.Equals\([\s\S]{0,160}preparedPlan\.Version',
    'GRF\.ITAgent-\{0\}\.exe',
    'UPDATE_RECOVERY_COMPLETED',
    'UPDATE_ROLLED_BACK',
    'S-1-5-18',
    'S-1-5-32-544'
)) {
    if ($updaterSource -notmatch $requiredPattern) {
        throw "update-agent.ps1 perdió el control esperado: $requiredPattern"
    }
}
foreach ($forbiddenPattern in @(
    'Invoke-WebRequest',
    'WebClient',
    'Authorization\s*:',
    'github[_-]?token',
    'Remove-Item[^\r\n]*-Recurse'
)) {
    if ($updaterSource -match $forbiddenPattern) {
        throw "update-agent.ps1 descarga sin el agente, requiere secretos o limpia de forma insegura: $forbiddenPattern"
    }
}
Write-Output "PASS updater firmado con rollback acotado"

$publishPath = Join-Path $agentRoot "publish.ps1"
$publishSource = [System.IO.File]::ReadAllText($publishPath)
$publishTokens = $null
$publishParseErrors = $null
$publishAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $publishPath,
    [ref]$publishTokens,
    [ref]$publishParseErrors)
if ($publishParseErrors.Count -ne 0) {
    throw "publish.ps1 tiene errores de sintaxis."
}
$publishFunctions = @($publishAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true) | ForEach-Object Name)
$publishCommands = @($publishAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst]
}, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($requiredFunction in @(
    "Assert-ChildPath",
    "Assert-PhysicalOutputPath",
    "Assert-PathWithinOutput",
    "Remove-PhysicalOutputTree"
)) {
    if ($requiredFunction -notin $publishFunctions `
        -or $requiredFunction -notin $publishCommands) {
        throw "publish.ps1 no define e invoca $requiredFunction."
    }
}
$publishRemoveCommands = @($publishAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.CommandAst] `
        -and $node.GetCommandName() -eq "Remove-Item"
}, $true))
if ($publishRemoveCommands.Count -ne 2) {
    throw "publish.ps1 debe borrar únicamente archivos y directorios físicos auditados."
}
foreach ($removeCommand in $publishRemoveCommands) {
    if ($removeCommand.Extent.Text -match '-Recurse' `
        -or $removeCommand.Extent.Text -notmatch '-LiteralPath') {
        throw "publish.ps1 no puede usar borrado recursivo ni rutas no literales."
    }
}
foreach ($requiredPattern in @(
    'MaxItems\s*=\s*20000',
    'MaxDepth\s*=\s*32',
    'System\.Collections\.Stack',
    'Get-ChildItem\s+-LiteralPath',
    'ReparsePoint',
    'Sort-Object\s+Depth\s+-Descending',
    'Remove-Item\s+-LiteralPath\s+\$safeFilePath',
    'Remove-Item\s+-LiteralPath\s+\$safeDirectoryPath',
    'Remove-PhysicalOutputTree\s+-Root\s+\$PSScriptRoot\s+-Output\s+\$outputPath'
)) {
    if ($publishSource -notmatch $requiredPattern) {
        throw "publish.ps1 perdió una guarda de limpieza física acotada: $requiredPattern"
    }
}
foreach ($requiredFile in @("deploy-remotely.ps1", "update-agent.ps1")) {
    if ($publishSource -notmatch ('"' + [regex]::Escape($requiredFile) + '"')) {
        throw "publish.ps1 no incluye $requiredFile en el paquete."
    }
}
Write-Output "PASS paquete incluye despliegue remoto y updater"
foreach ($requiredPattern in @(
    'UpdatePublicKeyPath',
    'ValidateSet\("stable", "pilot"\)',
    'publishedConfiguration\.update\.enabled = \$true',
    'manifest-\$UpdateChannel\.json',
    'PRIVATE KEY'
)) {
    if ($publishSource -notmatch $requiredPattern) {
        throw "publish.ps1 no materializa una config de update segura: $requiredPattern"
    }
}

$installSource = [System.IO.File]::ReadAllText((Join-Path $agentRoot "install.ps1"))
foreach ($requiredPattern in @(
    'GRF-IT-Agent-Updater',
    'New-ScheduledTaskTrigger[\s\S]{0,200}-Daily',
    'RandomDelay',
    'StartWhenAvailable',
    'MultipleInstances IgnoreNew',
    'updateEnabled',
    'sourceUpdateEnabled',
    'configuration\.update = \$sourceUpdateProperty\.Value',
    'publicKeyProperty\.Value -notmatch',
    'stagedExecutable',
    'Get-FileHash',
    'previousExecutable',
    'previousUpdater',
    '\[System\.IO\.File\]::Replace\(',
    'Export-ScheduledTask',
    'existingMainTaskXml',
    'Wait-ScheduledTaskRunning[\s\S]{0,120}-StableSeconds 5',
    'originalConfigContents',
    'no se pudo restaurar config\.json',
    'no se pudo reanudar la tarea principal anterior'
)) {
    if ($installSource -notmatch $requiredPattern) {
        throw "install.ps1 no registra correctamente el updater: $requiredPattern"
    }
}
foreach ($forbiddenPattern in @(
    'Remove-Item[^\r\n]*\$configPath',
    'Remove-Item[^\r\n]*\$credentialPath',
    'Remove-Item[^\r\n]*-Recurse'
)) {
    if ($installSource -match $forbiddenPattern) {
        throw "install.ps1 podría borrar configuración/credenciales o salir del scope: $forbiddenPattern"
    }
}

$uninstallSource = [System.IO.File]::ReadAllText((Join-Path $agentRoot "uninstall.ps1"))
if ($uninstallSource -notmatch 'GRF-IT-Agent-Updater' `
    -or $uninstallSource -notmatch 'Remove-BoundedPhysicalTree') {
    throw "uninstall.ps1 no elimina la tarea o los archivos acotados del updater."
}

$configuration = Get-Content -LiteralPath (Join-Path $agentRoot "config.example.json") -Raw |
    ConvertFrom-Json
if ($configuration.update.enabled -ne $false `
    -or $configuration.update.channel -ne "stable" `
    -or $configuration.update.manifestUrl `
        -ne "https://github.com/illeiva2/grf-it-agent-releases/releases/download/stable/manifest-stable.json" `
    -or $configuration.update.publicKeyPem -ne "") {
    throw "config.example.json debe dejar updates deshabilitados y apuntar al repo público esperado."
}
Write-Output "PASS configuración segura del updater"
