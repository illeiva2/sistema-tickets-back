#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Instala o actualiza el colector de red de GRF en este servidor (srv-datos).

.DESCRIPTION
  1. Copia GRF.NetCollector.exe a "C:\Program Files\GRF\NetCollector".
  2. Prepara C:\ProgramData\GRF\NetCollector (configuración, estado y logs) sólo para SYSTEM y
     Administradores: ahí quedan las huellas de los certificados y la sesión de UniFi.
  3. Si todavía no hay appsettings.json, deja el de ejemplo para completarlo.
  4. Genera la credencial del colector si no existe (variable de máquina GRF_RED_COLECTOR_SECRETO)
     y muestra SÓLO su SHA-256: con eso se registra en el back, sin que el secreto salga de acá.
  5. Registra la tarea programada "\GRF\Colector de red": cada minuto, como SYSTEM. Con -SinTarea
     no la crea (útil para instalar antes de registrar la credencial en el back).

.EXAMPLE
  .\install.ps1 -SinTarea        # primera vez: instala, genera la credencial y muestra su hash
  .\install.ps1                  # después de registrar el hash en el back: crea la tarea
  .\install.ps1 -RotarCredencial # genera una credencial nueva (hay que volver a registrarla)
#>
param(
    [switch]$SinTarea,
    [switch]$RotarCredencial
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$installDir = Join-Path $env:ProgramFiles 'GRF\NetCollector'
$dataDir = Join-Path $env:ProgramData 'GRF\NetCollector'
$exe = Join-Path $installDir 'GRF.NetCollector.exe'
$secretVariable = 'GRF_RED_COLECTOR_SECRETO'
$taskPath = '\GRF\'
$taskName = 'Colector de red'

if (-not (Test-Path (Join-Path $source 'GRF.NetCollector.exe'))) {
    throw "No está GRF.NetCollector.exe junto a este script ($source). Correr publish.ps1 antes."
}

# 1. Binario. Si la tarea está corriendo, se la deshabilita mientras se reemplaza el ejecutable.
$task = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { $task | Disable-ScheduledTask | Out-Null }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
        Copy-Item (Join-Path $source 'GRF.NetCollector.exe') $exe -Force
        break
    } catch {
        if ($attempt -eq 10) { throw }
        Start-Sleep -Seconds 6
    }
}
foreach ($file in 'README.md', 'appsettings.example.json', 'uninstall.ps1') {
    if (Test-Path (Join-Path $source $file)) { Copy-Item (Join-Path $source $file) $installDir -Force }
}
Write-Host "Ejecutable instalado en $installDir"

# 2. Carpeta de datos: sin herencia, sólo SYSTEM (S-1-5-18) y Administradores (S-1-5-32-544).
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
& icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudieron fijar los permisos de $dataDir" }

# 3. Configuración.
$config = Join-Path $dataDir 'appsettings.json'
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $source 'appsettings.example.json') $config
    Write-Warning "Se creó $config con valores de ejemplo: completarlo antes de crear la tarea."
}

# 4. Credencial del colector (32 bytes al azar en base64url: 43 caracteres, como las del agente).
$secret = [Environment]::GetEnvironmentVariable($secretVariable, 'Machine')
if ($RotarCredencial -or [string]::IsNullOrWhiteSpace($secret)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Environment]::SetEnvironmentVariable($secretVariable, $secret, 'Machine')
    Write-Host "Credencial nueva guardada en la variable de máquina $secretVariable."
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($secret.Trim())) | ForEach-Object { $_.ToString('x2') })
} finally { $sha.Dispose() }
$secret = $null
Write-Host ''
Write-Host 'SHA-256 de la credencial (se registra en el back con register-service-client.ts):'
Write-Host "  $hash"
Write-Host ''

# 5. Tarea programada.
if ($SinTarea) {
    if ($task) { Write-Warning "La tarea $taskPath$taskName quedó deshabilitada." }
    Write-Host 'No se creó la tarea (-SinTarea). Probar a mano con:'
    Write-Host "  & '$exe' --dry-run"
    return
}

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $installDir
# Server 2016 no acepta una repetición "indefinida": 10 años alcanza.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Lee router, switches y APs en sólo lectura y envía el estado al sistema de tickets (Red en vivo).' -Force | Out-Null
Enable-ScheduledTask -TaskPath $taskPath -TaskName $taskName | Out-Null
Write-Host "Tarea $taskPath$taskName registrada: corre cada minuto como SYSTEM."
Write-Host "Logs: $(Join-Path $dataDir 'logs')"
