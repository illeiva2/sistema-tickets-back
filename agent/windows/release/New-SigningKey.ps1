[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$PrivateKeyPath = (Join-Path $env:ProgramData "GRF\ITAgent\release-keys\agent-release-private.pem"),
    [string]$PublicKeyPath,
    [ValidateSet(3072, 4096)]
    [int]$KeySize = 3072,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
    throw "PrivateKeyPath es obligatorio."
}

$privatePath = Get-CanonicalPath $PrivateKeyPath
Assert-PathOutsideRepository -Path $privatePath

if ([string]::IsNullOrWhiteSpace($PublicKeyPath)) {
    $PublicKeyPath = Join-Path (Split-Path -Parent $privatePath) "agent-release-public.pem"
}
$publicPath = Get-CanonicalPath $PublicKeyPath
if ($privatePath.Equals($publicPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Las claves privada y pública deben usar archivos diferentes."
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Ejecutá este script desde Windows PowerShell como administrador para proteger la clave privada."
}

if (-not $Force -and ((Test-Path -LiteralPath $privatePath) -or (Test-Path -LiteralPath $publicPath))) {
    throw "Ya existe una clave en la ruta elegida. Usá -Force sólo si querés rotarla intencionalmente."
}

if (-not $PSCmdlet.ShouldProcess($privatePath, "Generar una nueva clave RSA de firma")) {
    return
}

$privateDirectory = Split-Path -Parent $privatePath
$publicDirectory = Split-Path -Parent $publicPath
New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $publicDirectory -Force | Out-Null

$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$privateAcl = [System.Security.AccessControl.FileSecurity]::new()
$privateAcl.SetOwner($administratorsSid)
$privateAcl.SetAccessRuleProtection($true, $false)
$privateAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $administratorsSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
))

function Assert-PrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $appliedAcl = Get-Acl -LiteralPath $Path
    if (-not $appliedAcl.AreAccessRulesProtected) {
        throw "La ACL de la clave privada todavía hereda permisos."
    }

    $ownerSid = $appliedAcl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($ownerSid.Value -ne $administratorsSid.Value) {
        throw "El grupo local Administradores no es propietario de la clave privada."
    }

    $hasAdministratorFullControl = $false
    $rules = $appliedAcl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    )
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -ne $administratorsSid.Value -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            throw "La clave privada tiene una entrada ACL distinta de Administradores/Allow."
        }

        if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
            [System.Security.AccessControl.FileSystemRights]::FullControl) {
            $hasAdministratorFullControl = $true
        }
    }

    if (-not $hasAdministratorFullControl) {
        throw "La clave privada no otorga FullControl al grupo local Administradores."
    }
}

if (-not (Test-Path -LiteralPath $privatePath)) {
    [System.IO.File]::WriteAllBytes($privatePath, [byte[]]@())
}
Set-Acl -LiteralPath $privatePath -AclObject $privateAcl
Assert-PrivateKeyAcl -Path $privatePath

try {
    Invoke-ReleaseCrypto -Arguments @(
        "generate",
        "--private", $privatePath,
        "--public", $publicPath,
        "--key-size", $KeySize.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    ) | Out-Null
    Set-Acl -LiteralPath $privatePath -AclObject $privateAcl
    Assert-PrivateKeyAcl -Path $privatePath
}
catch {
    if ((Get-Item -LiteralPath $privatePath).Length -eq 0) {
        Remove-Item -LiteralPath $privatePath -Force
    }
    throw
}

$publicFingerprint = (Get-FileHash -LiteralPath $publicPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Clave privada creada y restringida al grupo local Administradores: $privatePath"
Write-Host "Clave pública: $publicPath"
Write-Host "Huella SHA-256 de la clave pública: $publicFingerprint"
