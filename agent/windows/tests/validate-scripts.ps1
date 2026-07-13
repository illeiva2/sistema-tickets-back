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
        "Assert-SecureAgentPaths"
    )
    "uninstall.ps1" = @(
        "Get-SafeDirectChildDirectoryPath",
        "Assert-NoReparseTraversal",
        "Assert-AdministrativeOwner",
        "Assert-RestrictedDirectoryAcl",
        "Assert-RegularFileOrMissing",
        "Secure-ExistingAgentDirectory",
        "Assert-SecureExistingAgentPaths"
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

$publishPath = Join-Path $agentRoot "publish.ps1"
$publishSource = [System.IO.File]::ReadAllText($publishPath)
if ($publishSource -notmatch '"deploy-remotely\.ps1"') {
    throw "publish.ps1 no incluye el coordinador de despliegue remoto en el paquete."
}
Write-Output "PASS paquete incluye deploy-remotely.ps1"
