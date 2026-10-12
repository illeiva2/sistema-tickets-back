#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Quita el colector de red: la tarea programada y el ejecutable. La configuración, el estado y la
  credencial quedan, salvo que se pida lo contrario.

.PARAMETER BorrarDatos
  También borra C:\ProgramData\GRF\NetCollector (configuración, huellas de certificados, logs).

.PARAMETER BorrarCredencial
  También borra la variable de máquina GRF_RED_COLECTOR_SECRETO. Conviene revocar la credencial
  en el back además de borrarla acá.
#>
param(
    [switch]$BorrarDatos,
    [switch]$BorrarCredencial
)

$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:ProgramFiles 'GRF\NetCollector'
$dataDir = Join-Path $env:ProgramData 'GRF\NetCollector'

$task = Get-ScheduledTask -TaskPath '\GRF\' -TaskName 'Colector de red' -ErrorAction SilentlyContinue
if ($task) {
    $task | Stop-ScheduledTask -ErrorAction SilentlyContinue
    $task | Unregister-ScheduledTask -Confirm:$false
    Write-Host 'Tarea programada quitada.'
}

if (Test-Path $installDir) {
    Remove-Item -Recurse -Force $installDir
    Write-Host "Se quitó $installDir"
}

if ($BorrarDatos -and (Test-Path $dataDir)) {
    Remove-Item -Recurse -Force $dataDir
    Write-Host "Se quitó $dataDir"
}

if ($BorrarCredencial) {
    [Environment]::SetEnvironmentVariable('GRF_RED_COLECTOR_SECRETO', $null, 'Machine')
    Write-Host 'Se borró la variable GRF_RED_COLECTOR_SECRETO.'
}
