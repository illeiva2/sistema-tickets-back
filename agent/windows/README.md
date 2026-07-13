# GRF IT Agent para Windows

Agente liviano y saliente para inventario y salud de PCs Windows. Se publica como un único ejecutable `win-x64` self-contained, se inicia al arrancar Windows mediante una tarea programada como `SYSTEM` y no necesita un runtime .NET instalado en cada equipo.

El agente **no ejecuta comandos remotos**, no abre puertos, no inicia SSH/VNC y no acepta instrucciones desde la respuesta del servidor. Sólo informa si OpenSSH y UltraVNC están efectivamente activos (proceso o puerto configurado escuchando). La conexión remota sigue siendo una acción explícita del equipo de IT por los canales existentes.

## Qué informa

Cada heartbeat incluye:

- hostname y `MachineGuid` de Windows durante el enrolamiento;
- usuario interactivo activo, omitiendo `SYSTEM` cuando no hay sesión de usuario;
- IPs útiles y MACs, con la interfaz de gateway e IPv4 privada primero; se excluyen loopback, APIPA, interfaces caídas y túneles;
- uptime, CPU, RAM, batería/carga y discos fijos;
- versión/build de Windows;
- estado y puerto detectado de OpenSSH y UltraVNC.

Una vez por día de forma predeterminada agrega inventario: fabricante/modelo/serie/BIOS, modelo y procesadores lógicos, hasta 500 aplicaciones instaladas a nivel máquina y hasta 64 adaptadores de red. El payload se reduce automáticamente hasta un máximo seguro de 450 KB para quedar por debajo del parser de 512 KiB de la API.

## Seguridad

- `baseUrl` debe ser HTTPS. Se usa la validación TLS normal de Windows (cadena, hostname, vigencia y confianza); no existe opción para aceptar certificados inválidos.
- Los redirects HTTP están deshabilitados para que el token de enrolamiento nunca pueda redirigirse a otro host.
- El token de un uso se solicita como `SecureString`; nunca se pasa en texto plano por la línea de comandos ni se imprime.
- Antes del primer POST, el agente genera un secreto CSPRNG de 32 bytes y guarda un estado `pending` cifrado con DPAPI `LocalMachine`. Un crash o una respuesta perdida reutiliza exactamente el mismo token, `MachineGuid` y secreto.
- Al confirmar el servidor, se guarda `deviceId` junto al secreto como estado `enrolled`, también cifrado con DPAPI, y se sobrescribe/elimina el archivo de token temporal.
- El instalador asegura primero los ancestros `%ProgramData%\GRF` y `%ProgramFiles%\GRF`, y luego los directorios `ITAgent`, todos con herencia deshabilitada y acceso únicamente para `SYSTEM` y Administradores locales. Rechaza junctions/symlinks en cualquier componente y vuelve a validar las rutas antes de escribir archivos o registrar la tarea.
- DPAPI `LocalMachine` protege contra usuarios normales, pero un Administrador local o `SYSTEM` siguen siendo identidades de confianza y pueden descifrar datos de máquina si también acceden al binario.
- El log rota a 2 MiB y sólo contiene timestamp, nivel, identificador de evento, tipo de excepción y código HTTP. No registra URLs, bodies, headers, IDs, tokens, secretos ni mensajes de excepción.
- Reintentos transitorios usan backoff exponencial y jitter. Cada intervalo de heartbeat agrega ±10 % de jitter para evitar picos después de un encendido masivo.

No hace falta habilitar tráfico entrante para el agente: sólo necesita salida HTTPS hacia la API. Si la empresa usa proxy, debe estar disponible para la cuenta de máquina/SYSTEM.

## Contrato HTTP

Enrolamiento:

```text
POST /api/agent/enroll
```

```json
{
  "token": "<one-use>",
  "deviceSecret": "<base64url-43>",
  "machineGuid": "550e8400-e29b-41d4-a716-446655440000",
  "hostname": "PC-001",
  "agentVersion": "0.1.0",
  "osName": "Windows 11 Pro",
  "osVersion": "24H2"
}
```

Respuesta:

```json
{
  "success": true,
  "data": {
    "deviceId": "<id>",
    "nextHeartbeatSeconds": 60
  }
}
```

Heartbeat:

```text
POST /api/agent/heartbeat
X-Agent-Device-Id: <deviceId>
Authorization: Bearer <deviceSecret>
```

La respuesta también usa el envelope `{ "success": true, "data": { ... } }` y devuelve `acceptedAt`, `nextHeartbeatSeconds` y `state`. El agente usa la cadencia indicada, pero no interpreta `state` como una orden.

## Compilar y probar

Requisitos de desarrollo:

- Windows x64;
- SDK .NET 10 instalado;
- PowerShell 5.1 o superior.

No hay paquetes NuGet ni dependencias de terceros. Las pruebas son un runner BCL propio, por lo que tampoco necesitan un framework descargable.

```powershell
dotnet build .\src\Grf.ItAgent\Grf.ItAgent.csproj --configuration Release
dotnet run --project .\tests\Grf.ItAgent.Tests\Grf.ItAgent.Tests.csproj --configuration Release
.\tests\validate-scripts.ps1
```

Para generar el paquete self-contained:

```powershell
.\publish.ps1
```

El resultado queda en `artifacts\win-x64` e incluye `GRF.ITAgent.exe`, instalador, desinstalador, configuración de ejemplo, este README y un SHA-256. `publish.ps1` ejecuta las pruebas antes de publicar; `-SkipTests` queda reservado para diagnóstico local, no para releases.

## Release gate .NET

El agente productivo apunta a `net10.0-windows` y se publica self-contained para `win-x64`. `publish.ps1` bloquea cualquier release que no use ese target. Las PCs administradas no necesitan tener un runtime .NET instalado. Referencia: [política oficial de soporte de .NET](https://dotnet.microsoft.com/platform/support/policy/dotnet-core).

## Instalación manual

1. Ejecutar `publish.ps1` en una máquina de desarrollo.
2. Copiar la carpeta publicada al equipo objetivo por un canal administrativo confiable.
3. Verificar opcionalmente el hash de `GRF.ITAgent.exe` contra `SHA256SUMS.txt`.
4. Abrir PowerShell **como Administrador** dentro de esa carpeta.
5. Ejecutar:

```powershell
.\install.ps1 -BaseUrl "https://sistema-tickets-back.onrender.com/"
```

El script pedirá el token de un uso sin mostrarlo. También se puede preparar un `SecureString` interactivamente, sin texto plano en el historial:

```powershell
$token = Read-Host "Token de enrolamiento" -AsSecureString
.\install.ps1 -BaseUrl "https://sistema-tickets-back.onrender.com/" -EnrollmentToken $token
```

El instalador es idempotente: detiene la tarea existente, reemplaza el ejecutable, conserva configuración/credenciales, vuelve a aplicar las ACL y registra la tarea `GRF-IT-Agent` como `SYSTEM`, con trigger al inicio y reinicio ante fallos. Si ya hay credencial o enrolamiento pendiente, no solicita ni reemplaza el token.

Una actualización desde la primera versión endurece automáticamente un ancestro `GRF` real con owner administrativo y conserva el leaf `ITAgent` ya protegido. Si `GRF` fue precreado por un usuario estándar, es un junction/symlink o el leaf no tiene ACL confiables, la instalación aborta antes de leer o escribir. En ese caso un administrador debe inspeccionar la ruta, retirar manualmente el objeto no confiable y ejecutar de nuevo el instalador; el script no intenta “reparar” un enlace potencialmente hostil.

Para actualizar, copiar una publicación nueva y ejecutar de nuevo `install.ps1` con la misma URL. No se necesita un token nuevo mientras se conserve `credentials.dat`.

## Archivos locales

Directorio de binario:

```text
%ProgramFiles%\GRF\ITAgent\GRF.ITAgent.exe
```

Directorio de datos protegido:

```text
%ProgramData%\GRF\ITAgent\
  config.json          configuración sin secretos
  enrollment.token     token temporal; desaparece tras enrolar
  credentials.dat      estado pending/enrolled cifrado con DPAPI
  state.json            fecha del último inventario aceptado
  agent.lock            lock exclusivo de instancia
  agent.log[.1]         eventos operativos sin datos sensibles
```

La configuración de ejemplo es deliberadamente estricta. Los nombres de archivos deben ser locales al directorio de datos; no se admiten rutas absolutas ni `..`.

## Diagnóstico

- Estado de la tarea: `Get-ScheduledTask -TaskName GRF-IT-Agent`.
- Último resultado: `Get-ScheduledTaskInfo -TaskName GRF-IT-Agent`.
- Eventos seguros: `%ProgramData%\GRF\ITAgent\agent.log`.
- Código de salida `2`: configuración inválida.
- El enrolamiento no completado permanece en un bucle durable con backoff/jitter. Conserva el mismo estado `pending`, token y secreto DPAPI aunque la API esté caída durante horas; no depende del contador de reinicios de la tarea.
- Si TLS falla, instalar/corregir la CA en el almacén de la máquina o corregir hostname/vigencia. No se debe desactivar la validación.
- Si el `MachineGuid` falta o no es un GUID válido, el agente aborta antes del POST para evitar que varias PCs colisionen.

## Desinstalación

Conservar configuración y credencial para reinstalar:

```powershell
.\uninstall.ps1
```

Eliminar además datos, token temporal y credencial DPAPI:

```powershell
.\uninstall.ps1 -PurgeData
```

`-PurgeData` sólo elimina la lista conocida de archivos del agente y sólo quita directorios si quedan vacíos; no borra recursivamente contenido desconocido. El token se sobrescribe antes de eliminarse como mejor esfuerzo, aunque SSD, journaling y backups pueden impedir garantizar un borrado físico.
