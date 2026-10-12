# Colector de red (Red en vivo)

Programa .NET que corre en un servidor de la planta (srv-datos), lee el estado del router, los
switches y los APs, y lo envía al sistema de tickets para la pantalla **IT → Red en vivo**.

- **Sólo lectura.** En los MikroTik usa la API cifrada (api-ssl, 8729) con un usuario de un grupo
  `read,api` y sólo comandos `print` / `monitor once`. En HPE, TP-Link y SwOS usa SNMP v2c (o v1)
  con una community de lectura: sólo GET y GETBULK. En UniFi, la API clásica del controlador con
  un usuario local *View Only*. Nunca cambia la configuración de un equipo.
- **Sólo tráfico saliente.** Envía por HTTPS a `POST /api/network-collector/snapshot` con una
  credencial de servicio (`x-service-client` + `Bearer`). No abre puertos en la planta.
- **Las claves no van en archivos.** Cada una es una variable de máquina del servidor y la
  configuración sólo nombra la variable.

## Qué envía

Cada minuto, por cada equipo: nombre, modelo, firmware, serie, uptime y sus puertos físicos
(enlace, velocidad, dúplex, VLAN nativa, descripción y vecinos LLDP/MNDP). Cada 5 minutos se suma
la lista de APs del controlador UniFi (estado, modelo y cantidad de clientes; nunca datos de los
clientes). También envía los **enlaces** entre equipos, que deduce así:

1. **Tablas MAC.** El colector consulta a cada equipo desde el servidor, así que la respuesta de
   cada uno sube por todos los switches que tiene arriba hasta el router. Cada switch aprende la
   MAC del router en su puerto de subida y la de cada equipo de abajo en el puerto que baja hacia
   él. El padre de un equipo es el switch más profundo que lo ve en un puerto de bajada. Se mira
   sólo la VLAN de gestión de cada equipo (la de su IP en el router): otras VLANs pueden tomar
   caminos distintos, por ejemplo a través de un AP en mesh.
2. **LLDP.** Un vecino LLDP o CDP en un puerto es una conexión directa y da el puerto exacto. MNDP
   no cuenta: los MikroTik lo difunden por toda la VLAN.

Desde la versión 0.2 también envía los **equipos finales** (PCs, impresoras, cámaras, teléfonos,
clientes Wi-Fi): por cada MAC que no es de la infraestructura, el switch y el puerto de acceso
donde está, la VLAN, la IP (de la tabla ARP del router o de la concesión DHCP) y el nombre que
pidió por DHCP. Se ubican así:

- Se descartan los puertos que van a otro switch (los de los enlaces, aquellos donde aparece la MAC
  de un switch o del router) y los agregados `lagNNN`: lo que queda es el puerto de acceso.
- Si un equipo aparece en varios switches, gana el más profundo del árbol.
- Las MACs que aparecen en el puerto de un AP son clientes Wi-Fi de ese AP.
- Un puerto con varios equipos (3 o más) se marca como compartido: suele ser un switch sin gestión
  o un grabador de cámaras.

Las tablas MAC completas no se envían; sólo los enlaces y dónde está cada equipo final. Los nombres
DHCP pueden incluir nombres de personas: la pantalla la ven sólo los agentes y administradores.

## Archivos

| Qué | Dónde |
|---|---|
| Ejecutable | `C:\Program Files\GRF\NetCollector\GRF.NetCollector.exe` |
| Configuración | `C:\ProgramData\GRF\NetCollector\appsettings.json` |
| Estado (huellas de certificados, sesión de UniFi) | `C:\ProgramData\GRF\NetCollector\state.json` |
| Logs (14 días) | `C:\ProgramData\GRF\NetCollector\logs\colector-AAAAMMDD.log` |
| Tarea programada | `\GRF\Colector de red`, cada minuto, como SYSTEM |

La carpeta de datos queda sólo para SYSTEM y Administradores.

## Variables de máquina

| Variable | Para qué |
|---|---|
| `GRF_RED_COLECTOR_SECRETO` | Credencial del colector ante el back (la genera `install.ps1`). |
| `GRF_RED_MIKROTIK_CLAVE` | Clave del usuario `grf-monitor` en los MikroTik. |
| `GRF_RED_SNMP_COMMUNITY` | Community de lectura de HPE, TP-Link y SwOS. |
| `GRF_RED_UNIFI_USUARIO` / `GRF_RED_UNIFI_CLAVE` | Usuario local *View Only* del controlador UniFi. |

## Instalación

1. Publicar (en una PC con el SDK de .NET 10):

   ```powershell
   .\publish.ps1
   ```

   Deja en `artifacts\win-x64` un único ejecutable autocontenido (no necesita .NET en el servidor)
   y los scripts.

2. Copiar `artifacts\win-x64` al servidor y, en un PowerShell de administrador:

   ```powershell
   .\install.ps1 -SinTarea
   ```

   Instala, deja la configuración de ejemplo en `C:\ProgramData\GRF\NetCollector\appsettings.json`
   (completarla con los equipos reales), genera la credencial y muestra **sólo su SHA-256**.

3. Registrar la credencial en el back con ese hash (el secreto nunca sale del servidor):

   ```bash
   npx tsx src/scripts/register-service-client.ts red-colector-srvdatos network:ingest <sha256>
   ```

4. Probar sin enviar nada y, si todo responde, crear la tarea:

   ```powershell
   & 'C:\Program Files\GRF\NetCollector\GRF.NetCollector.exe' --dry-run
   .\install.ps1
   ```

## Configuración (`appsettings.json`)

Ver `appsettings.example.json`. Por equipo: `Ip`, `Driver` (`routeros` o `snmp`), `Role`
(`router`, `core` o `access`) y, para los MikroTik, opcionalmente `CertificateSha256`.

La sección `Endpoints` es opcional: `Enabled` (sí por defecto), `ExcludeVlans` (VLANs cuyos
equipos no se envían; en GRF, la 300 de invitados) y `SharedPortThreshold` (desde cuántos equipos
un puerto se marca compartido; 3 por defecto).

Los certificados de los MikroTik y del controlador UniFi son autofirmados. Si la configuración trae
la huella, se exige esa; si no, la primera que se ve queda anotada en `state.json` y desde ahí se
exige. Un certificado distinto corta la conexión **antes** de mandar la clave. Si se cambió el
certificado a propósito, borrar esa línea de `state.json` (o poner la huella nueva en la
configuración).

## Diagnóstico

```powershell
GRF.NetCollector.exe --dry-run                 # sondea y muestra un resumen, sin enviar
GRF.NetCollector.exe --dry-run --json salida.json
GRF.NetCollector.exe --topology-debug          # además: en qué puerto ve cada switch a los demás
```

Códigos de salida: 0 bien (aunque algún equipo no responda), 2 el envío falló, 3 error inesperado,
64 argumentos inválidos, 78 configuración inválida.

Notas de campo:

- Los TP-Link TL-SG2428P con LLDP activo a veces mandan una respuesta que la librería SNMP no puede
  decodificar en las tablas LLDP; se usa lo que llegó y el log lo avisa.
- El SwOS informa la tabla MAC de sus agregados (LAG) como puertos 130 en adelante, sin decir qué
  puertos físicos los forman: esos enlaces se envían como `lag130`, `lag131`…
- Algunos TP-Link numeran la tabla MAC por puerto físico (1..28) y otros por puerto de bridge
  (49153..): se aceptan las dos formas.

## Desinstalar

```powershell
.\uninstall.ps1                       # quita la tarea y el ejecutable
.\uninstall.ps1 -BorrarDatos -BorrarCredencial
```

## Pruebas

```powershell
dotnet run --project tests\Grf.NetCollector.Tests -c Release
```
