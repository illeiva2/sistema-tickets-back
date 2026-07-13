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
    if ($source -notmatch "ReparsePoint" `
        -or $source -notmatch 'S-1-5-18' `
        -or $source -notmatch 'S-1-5-32-544') {
        throw "$($entry.Key) perdió controles de reparse o ACL esperados."
    }
    if ($source -match 'Remove-Item[^\r\n]*-Recurse') {
        throw "$($entry.Key) no puede borrar recursivamente."
    }

    Write-Output "PASS seguridad estática $($entry.Key)"
}
