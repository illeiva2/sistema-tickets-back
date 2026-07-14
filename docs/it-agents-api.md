# API de agentes IT

Contrato del gateway de monitoreo y acceso remoto directo. No existe ningún
endpoint de comandos arbitrarios. Los endpoints humanos requieren JWT con rol
`AGENT` o `ADMIN`; los endpoints de máquina usan credenciales individuales.

Todas las respuestas usan `{ "success": true, "data": ... }`. Los errores
usan el envelope estándar `{ "success": false, "error": { "code", "message" } }`.

## Estado operativo

El estado expuesto por la API se deriva de `lastSeenAt`, no de `connState`:

- `ONLINE`: agente activo visto en los últimos 120 segundos.
- `STALE`: agente activo visto hace más de 120 segundos y hasta 10 minutos.
- `OFFLINE`: sin heartbeat, más de 10 minutos o agente revocado.

El heartbeat recomendado es cada 60 segundos. Las métricas se almacenan como
máximo cada 5 minutos y se retienen 14 días. El inventario sólo crea un
snapshot cuando está presente, conservando los últimos 30 por dispositivo.

## Gestión IT (`/api/it/agents`)

### Lookups

`GET /lookups` devuelve activos compatibles y todavía no vinculados:

```json
{
  "assets": [
    {
      "id": "...",
      "assetTag": "NB-0001",
      "type": "NOTEBOOK",
      "status": "ASSIGNED",
      "brand": "Dell",
      "model": "Latitude"
    }
  ]
}
```

### Tokens de enrolamiento

- `GET /enrollment-tokens?status=AVAILABLE|USED|EXPIRED|REVOKED`
- `POST /enrollment-tokens` con `{ "label"?: string, "expiresAt"?: ISO-8601, "maxUses"?: 1..250 }`
- `POST /enrollment-tokens/:id/revoke` con body vacío

La creación devuelve `{ token, plainToken }`. `plainToken` tiene 256 bits y se
muestra una sola vez; sólo su SHA-256 se persiste. `maxUses` vale 1 por defecto
y permite enrolar un lote de hasta 250 equipos. La respuesta informa
`useCount`, `remainingUses` y `enrolledDevices`. El vencimiento permitido es de
10 minutos a 7 días. La revocación es lógica y atómica; puede cancelar los usos
restantes de un lote parcialmente utilizado.

### Dispositivos

- `GET /devices?q=&state=&isActive=&assetId=&page=&pageSize=`
- `GET /devices/:id`
- `PATCH /devices/:id` con `{ "expectedUpdatedAt": ISO-8601, "assetId": string|null }`
- `POST /devices/:id/activate` con `{ "expectedUpdatedAt": ISO-8601 }`
- `POST /devices/:id/revoke` con `{ "expectedUpdatedAt": ISO-8601 }`
- `GET /devices/:id/snapshots?page=&pageSize=`
- `GET /devices/:id/metrics?from=&to=&limit=`

El detalle incluye `recentMetrics`, `latestSnapshot` (metadatos) y
`activeSessions`. Nunca incluye `secretHash`. Los conflictos optimistas usan
`AGENT_DEVICE_VERSION_CONFLICT`. Revocar un agente también finaliza sus
sesiones activas con estado `ERROR`.

### Acceso remoto directo

- `POST /devices/:id/remote-sessions` con `{ "protocol": "SSH"|"VNC" }`
- `POST /remote-sessions/:id/close` con body vacío

La apertura devuelve:

```json
{
  "session": { "id": "...", "kind": "SSH", "status": "ACTIVE" },
  "connection": {
    "protocol": "SSH",
    "target": "10.0.0.25",
    "port": 22,
    "uri": "ssh://10.0.0.25:22",
    "scope": "DIRECT",
    "requiresNetworkReachability": true,
    "warning": "Acceso directo: ... No se incluyen credenciales."
  }
}
```

SSH usa puerto 22. VNC usa exclusivamente `DeviceVncCredential.vncPort` si es
válido, o 5900. No se lee ni descifra la contraseña VNC. El operador necesita
alcance directo al destino por LAN o VPN. El cierre no lleva CAS porque
`RemoteSession` no tiene `updatedAt`; la transición condiciona atómicamente
`status=ACTIVE` y `endedAt=null`.

## Gateway de máquina (`/api/agent`)

Estas rutas están excluidas del rate limit web global y usan límites dedicados:
enrolamiento apto para rollout detrás de NAT, techo NAT alto para heartbeat y
límite adicional por `deviceId`. El body máximo es 512 KiB.

### Enrolamiento

`POST /enroll`:

```json
{
  "token": "base64url-32-bytes",
  "deviceSecret": "base64url-32-bytes",
  "machineGuid": "550e8400-e29b-41d4-a716-446655440000",
  "hostname": "PC-GRF-001",
  "agentVersion": "1.0.0",
  "osName": "Windows 11 Pro",
  "osVersion": "10.0.26100"
}
```

El agente genera `deviceSecret` mediante CSPRNG, lo conserva estable durante
retries y lo protege localmente. La respuesta es
`{ "deviceId": "...", "nextHeartbeatSeconds": 60 }`; el servidor nunca
devuelve el secreto. Un retry del mismo token, MachineGuid y secreto es
idempotente, incluso si la respuesta anterior se perdió y el token luego venció,
se agotó o fue revocado. Un token nuevo puede re-enrolar el mismo MachineGuid y
rotar el secreto sin duplicar el dispositivo ni cambiar `assetId`/`isActive`,
pero por seguridad ese token debe ser individual (`maxUses = 1`). Los tokens por
lote sólo admiten máquinas nuevas y no pueden tomar control de agentes existentes.
Cada dispositivo conserva `enrollmentTokenId`; el contador se consume mediante
CAS dentro de una transacción SERIALIZABLE y el AuditLog conserva la trazabilidad.

### Heartbeat

`POST /heartbeat` requiere:

- `X-Agent-Device-Id: <deviceId>`
- `Authorization: Bearer <deviceSecret>`

El secreto se compara mediante SHA-256 y comparación timing-safe. ID inválido,
secreto inválido y agente revocado producen el mismo `AGENT_AUTH_INVALID`.

Payload estricto:

```json
{
  "hostname": "PC-GRF-001",
  "username": "GRF\\usuario",
  "ipAddresses": ["10.0.0.25"],
  "macAddresses": ["AA:BB:CC:DD:EE:FF"],
  "uptimeSeconds": 3600,
  "cpuPercent": 20.5,
  "ram": { "totalBytes": 17179869184, "usedBytes": 8589934592 },
  "battery": { "percent": 85, "charging": false },
  "disks": [{ "name": "C:", "totalBytes": 1000, "usedBytes": 500 }],
  "services": {
    "ssh": { "available": true, "port": 22 },
    "vnc": { "available": true, "port": 5900 }
  },
  "os": { "name": "Windows 11 Pro", "version": "10.0.26100", "build": "26100" },
  "agentVersion": "1.0.0",
  "inventory": {
    "collectedAt": "2026-07-13T10:00:00.000Z",
    "hardware": {
      "manufacturer": "Dell",
      "model": "Latitude",
      "serialNumber": "...",
      "biosVersion": "..."
    },
    "cpu": { "model": "Intel", "cores": 8, "logicalProcessors": 16 },
    "memoryModules": [
      {
        "capacityBytes": 8589934592,
        "manufacturer": "...",
        "partNumber": "...",
        "serialNumber": "..."
      }
    ],
    "software": [
      { "name": "Microsoft 365", "version": "1", "publisher": "Microsoft" }
    ],
    "networkAdapters": [
      {
        "name": "Ethernet",
        "description": "...",
        "macAddress": "AA:BB:CC:DD:EE:FF",
        "ipAddresses": ["10.0.0.25"]
      }
    ]
  }
}
```

Máximos principales: 32 IP/MAC, 64 discos, 32 módulos de memoria, 500
programas y 64 adaptadores. Los zone IDs IPv6 (`fe80::1%12`) se validan y
eliminan antes de canonicalizar; loopback/APIPA/link-local no se eligen como
`primaryIp`. Los puertos reportados se validan pero no se persisten porque el
modelo actual no tiene columnas para ellos.
