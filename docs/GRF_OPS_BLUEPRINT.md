# GRF OPS — Blueprint ejecutable

Estado: propuesta base para implementación  
Ámbito: una empresa, una sede, tres usuarios de IT  
Integración: módulo del sistema de tickets existente, con componentes locales aislados

## 1. Objetivo

GRF OPS será el centro operativo de IT para inventario, asignaciones, líneas móviles, mantenimientos, compras, proveedores, red, telemetría de endpoints y acceso remoto controlado.

El producto no intentará reemplazar en el primer ciclo a un NMS completo como Zabbix ni convertirse en una plataforma de ejecución remota arbitraria. La prioridad es construir una fuente confiable y auditable de activos y operaciones, y luego agregar automatización sin ampliar innecesariamente la superficie de ataque.

### Escala de diseño inicial

| Recurso | Volumen conocido |
|---|---:|
| Sedes | 1 |
| Personal | 90 |
| Usuarios de la aplicación | 3, exclusivamente IT |
| PCs Windows 10/11 | 60 |
| Servidores | Windows Server 2016/2019 |
| Celulares | 100 |
| Dispositivos de red | 25 |
| Cámaras Hikvision | 40 |
| Controlador Wi-Fi/red | UniFi Controller en AWS |

La arquitectura deberá soportar sin rediseño al menos 500 activos, 150 agentes y tres sedes. No se optimizará todavía para múltiples empresas ni decenas de miles de endpoints.

## 2. Decisiones de producto

1. GRF OPS se incorpora al frontend y backend actuales para compartir navegación, autenticación, tickets y despliegues.
2. Los dominios de gestión IT reutilizarán los modelos aditivos ya presentes en Prisma y mantendrán módulos/contratos propios, evitando duplicar tablas o acoplarse a lógica interna de tickets.
3. Vercel, Render y Neon forman el **plano de control cloud**.
4. Una VM disponible en Proxmox alojará el **plano local**, inicialmente el Connector y posteriormente Guacamole.
5. Los agentes sólo iniciarán conexiones salientes; no escucharán puertos de administración.
6. Los empleados del ERP serán personas administradas, no usuarios de login.
7. El acceso se limitará al dominio `grf.com.ar` y a una allowlist exacta de los tres integrantes de IT.
8. El primer corte incluirá un piloto read-only del agente, pero no habilitará VNC/SSH desde Internet.
9. Las alertas saldrán en la aplicación y por email. WhatsApp queda como integración posterior.

## 3. Límites explícitos

Fuera del primer corte:

- Monitoreo histórico de alta frecuencia equivalente a Zabbix.
- Streaming, grabación o almacenamiento de video de cámaras.
- Administración de firmware o configuración de cámaras Hikvision.
- Patching, despliegue de software o ejecución libre de PowerShell.
- Descubrimiento agresivo de puertos o vulnerabilidades.
- Contabilidad, pagos o reemplazo del ERP.
- Sincronización automática del ERP; se usará importación controlada desde Excel.
- Login de empleados fuera de IT.
- Acceso VNC directo desde Internet o apertura pública del puerto 5900.
- Grabación de sesiones remotas.
- Notificaciones por WhatsApp.

Las cámaras se tratarán inicialmente como `NetworkDevice(type=CAMERA)`: IP, MAC si está disponible, modelo/nombre, ubicación y estado manual. Sólo podrán recibir `Maintenance` si además se vinculan a un `Asset`; la disponibilidad automática comienza en Fase 2. No se administrarán credenciales de video en el primer corte.

## 4. Módulos

### 4.1 Identidad y permisos

- Login Google Workspace por OIDC.
- Allowlist de los tres emails de IT.
- Roles del primer corte, ya existentes en `UserRole`: `ADMIN` y `AGENT`; `USER` no puede acceder a `/it/*`.
- `ADMIN` administra configuración, autoriza compras y gestiona secretos; `AGENT` opera inventario, asignaciones, mantenimientos y solicitudes.
- Roles granulares como `OPS_ADMIN`, `OPS_TECH`, `OPS_VIEWER` y permisos separados por módulo son una evolución posterior que requiere migración de autorización.
- Auditoría de login, lectura sensible, cambio, exportación, aprobación y sesión remota.

### 4.2 Personas y estructura

- Importación de empleados desde Excel del ERP.
- `Person.employeeNumber` como clave ERP estable, nombre, email laboral, `Department`, cargo y `EmploymentStatus` (`ACTIVE`, `ON_LEAVE`, `TERMINATED`).
- Vista previa, errores por fila y confirmación antes de aplicar una importación.
- Altas, actualizaciones y bajas lógicas idempotentes por identificador ERP.
- Los empleados importados no adquieren acceso a GRF OPS.
- Centro de costo separado de `Department` queda como ampliación posterior.

### 4.3 Inventario y CMDB

- Tipos del primer corte según `AssetType`: `DESKTOP`, `NOTEBOOK`, `PHONE`, `TABLET`, `MONITOR`, `PRINTER`, `PERIPHERAL`, `NETWORK_DEVICE`, `SERVER`, `OTHER`.
- Identificadores del modelo actual: `assetTag` y `serialNumber`; UUID, IMEI, MAC, hostname y demás especificaciones viven en `Asset.specs` validado por tipo.
- Ciclo de vida según `AssetStatus`: `IN_STOCK`, `ASSIGNED`, `IN_REPAIR`, `RETIRED`, `LOST`.
- `AssetAssignment` conserva el historial de persona y/o sector; `Asset.location` conserva sólo la ubicación actual y el historial de ubicaciones queda para después.
- Garantía y compra de origen mediante `PurchaseItem`; catálogos separados de fabricante/modelo y documentos generales de activo quedan para después.
- Etiquetas QR y búsqueda global.
- Una cámara se registra como `NetworkDevice(type=CAMERA)` y, si se necesita trazabilidad patrimonial, se vincula opcionalmente a un `Asset(type=NETWORK_DEVICE)`.

### 4.4 Celulares y líneas

- Celular como `Asset(type=PHONE)` y línea como `PhoneLine`; en el primer corte la SIM/eSIM no es entidad separada y su ICCID actual vive en `PhoneLine.simIccid`.
- Número E.164, `PhoneCarrier`, plan, ICCID, costo periódico y `PhoneLineStatus` (`ACTIVE`, `AVAILABLE`, `SUSPENDED`, `CANCELLED`).
- `PhoneLineAssignment` conserva el historial de línea, persona y celular asociado al momento de la asignación.
- Validación para evitar dos asignaciones activas incompatibles.
- Un historial independiente de cambios físicos de SIM queda como ampliación posterior.

### 4.5 Mantenimiento y repuestos

- `Maintenance` se asocia a un solo `Asset`; puede ser `PREVENTIVE`, `CORRECTIVE` o `UPGRADE`.
- Descripción, técnico o `Supplier`, fechas, costo, moneda y repuestos en `parts` JSON.
- Estados según `MaintenanceStatus`: `SCHEDULED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.
- Vínculo opcional directo a `Ticket` mediante `ticketId`.
- Acciones normalizadas, stock de repuestos, tiempo fuera de servicio y adjuntos propios del mantenimiento quedan para después.

### 4.6 Compras y proveedores

- `Supplier` conserva proveedor, contactos, CUIT, categorías y estado.
- `Purchase` conserva solicitante, justificación obligatoria, proveedor, moneda, total, tipo de cambio, factura y autorizador.
- Flujo actual de `PurchaseStatus`: `REQUESTED` → `APPROVED` → `ORDERED` → `RECEIVED`; `CANCELLED` cubre cancelación o rechazo documentado en notas.
- Sólo `ADMIN` autoriza; `PurchaseAttachment` guarda presupuesto, factura o remito.
- `PurchaseItem` conserva descripción, cantidad y precio unitario; al recibir puede generar activos inventariables.
- Cotizaciones estructuradas, impuestos por línea, recepción parcial, múltiples aprobadores y centros de costo son ampliaciones posteriores.

### 4.7 Red y topología

- `Site`, `NetworkDevice` y `NetworkLink` forman el inventario operativo del primer corte.
- `NetworkDevice` conserva tipo, `NetworkDeviceStatus` (`ACTIVE`, `INACTIVE`, `MAINTENANCE`, `RETIRED`), IP de gestión, MAC, VLANs, ubicación y vínculo patrimonial opcional.
- `NetworkLink` conserva extremos, puertos, VLANs, velocidad y `NetworkLinkType`; `NetworkTopologyView` y posiciones permiten la edición manual.
- Integración posterior con UniFi Controller en AWS mediante cuenta de sólo lectura.
- Descubrimiento local posterior mediante Connector, SNMPv3 y LLDP.
- Cámaras visibles en la topología como endpoints, sin video.
- Entidades IPAM separadas para interfaz, IP, subred y VLAN, además de origen/confianza de enlaces, son una ampliación posterior.

### 4.8 Endpoints y alertas

- Agente Windows de sólo lectura.
- `AgentDevice` registra MachineGuid, sistema operativo, hostname, IP/MAC, uptime, CPU, memoria, batería y detección de UltraVNC/OpenSSH.
- El estado persistido es `AgentConnState.ONLINE` o `OFFLINE`; “stale” se calcula desde `lastSeenAt` y la revocación se representa con `isActive=false`.
- `AgentMetricSample` guarda CPU, RAM, uso de disco y batería cada cinco minutos; `AgentInventorySnapshot` guarda inventario JSON.
- En el primer corte, los avisos reutilizan `Notification` y email. Un modelo dedicado de alertas, reglas, acknowledgements y recuperaciones queda para después.

### 4.9 Acceso remoto

- Guacamole como gateway HTML5 para UltraVNC y SSH.
- `RemoteSession` soporta `SSH`/`VNC` y estados `ACTIVE`, `CLOSED`, `ERROR` con operador, destino, tiempos, tráfico y error.
- Sin grabación ni consentimiento interactivo, según la política indicada.
- Auditoría únicamente de metadata: solicitante, destino, protocolo, inicio, fin y resultado.
- Motivo/ticket, aprobación JIT y TTL requieren ampliar el modelo antes de habilitar la Fase 3; no se atribuyen al primer corte.

## 5. Arquitectura híbrida

```text
Usuario IT
   |
   | Google OIDC
   v
Frontend actual (Vercel)
   |
   v
Backend actual + módulos OPS (Render) ---- Object storage privado
   |                     |
   |                     +---- Email transaccional
   v
PostgreSQL (Neon)

Agentes Windows ---- HTTPS/WebSocket + secreto individual ---> Render
                                                              ^
VM Proxmox: OPS Connector ---- HTTPS saliente ----------------+
      |              |
      |              +---- UniFi Controller en AWS
      +---- SNMPv3 / LLDP / ICMP en LAN

Usuario IT en LAN/VPN ---- Reverse proxy interno ---- Guacamole/guacd
                                                     |
                                                     +---- UltraVNC / SSH
```

### Plano de control cloud

- El frontend existente incorpora las rutas canónicas `/it/*` y reutiliza el design system.
- El backend existente expone las rutas canónicas `/api/it/*` y mantiene límites de módulo claros.
- Neon conserva datos de negocio y telemetría compacta.
- Los adjuntos se guardan en object storage privado S3-compatible con URLs firmadas; Render no se usa como almacenamiento persistente.
- Un worker procesa importaciones, emails, agregaciones y vencimientos.

### Plano local en Proxmox

El `OPS Connector` será un servicio desplegado en contenedor o VM pequeña, sin puertos publicados a Internet. Sus responsabilidades futuras serán:

- Sondeo local de dispositivos autorizados.
- Consulta read-only de UniFi.
- Buffer temporal cuando Render no esté disponible.
- Ejecución de tareas de descubrimiento firmadas y con alcance explícito.
- Reporte saliente por HTTPS 443.

Guacamole deberá quedar en una red separada del Connector. Su URL será accesible sólo desde la LAN o una VPN de IT. La falta de cobertura VPN se mostrará como destino no alcanzable; no se resolverá exponiendo VNC o Guacamole públicamente.

### Agente Windows

- Implementación recomendada: .NET Worker Service compatible con Windows 10/11 y Server 2016/2019.
- Enrolamiento mediante `AgentEnrollmentToken` de un solo uso, con hash, vencimiento y trazabilidad del creador.
- El primer corte autentica WebSocket/HTTPS con un secreto individual cuyo hash vive en `AgentDevice.secretHash`; el secreto plano se entrega una vez y se protege localmente con DPAPI.
- `MachineGuid` es la identidad estable para evitar duplicados al reiniciar o reenrolar.
- El primer corte sólo publica heartbeat, métricas e inventario; no incluye un modelo ni endpoint de comandos remotos.
- Firma de binarios, actualización automática, requests asimétricamente firmados y buffer offline son hardening posterior.

## 6. Modelo de datos de alto nivel

Esta sección distingue el **primer corte**, que usa los modelos ya presentes en `prisma/schema.prisma`, de ampliaciones que requieren una migración posterior. No se crearán tablas `ops_*` paralelas.

### Identidad

- `User`: cuenta existente; `googleId` almacena el `sub` de Google y `role` usa `ADMIN` o `AGENT` para IT.
- `Person`: empleado ERP; `userId` opcional mantiene separada la persona de la cuenta.
- `Department`: sector organizativo del primer corte.
- `AuditLog`: actor, entidad, acción y metadata JSON; correlation ID y snapshots redactados se guardan en `meta`.
- `Notification` y `NotificationPreferences`: canal in-app/email reutilizado por los avisos iniciales.

### Inventario

- `Asset`: raíz patrimonial, con `AssetType`, `AssetStatus`, `assetTag`, serie, marca/modelo, `specs`, ubicación, garantía y compra de origen.
- `AssetAssignment`: historial de persona y/o `Department`; `endAt=null` identifica la asignación vigente.
- `Maintenance`: mantenimiento de un activo, repuestos JSON, costo, técnico/proveedor y ticket opcional.
- `Supplier`, `Purchase`, `PurchaseItem`, `PurchaseAttachment`: flujo de compras existente.
- `Ticket.assetId` y `Maintenance.ticketId`: relaciones directas con tickets; no se agrega una tabla de links genérica en el primer corte.

### Móviles

- `PhoneLine`: número, operador, plan, costo, ICCID/PUK actual, estado, titular y celular actual.
- `PhoneLineAssignment`: historial de persona, línea y celular; `returnedAt=null` identifica la asignación vigente.
- Una entidad `Sim` independiente sólo se evaluará si se requiere historial de reemplazos de SIM no cubierto por la línea.

### Red y topología

- `Site`, `NetworkDevice`, `NetworkLink`.
- `NetworkTopologyView`, `NetworkTopologyNodePosition`.
- `NetworkDevice.assetId` vincula, cuando corresponde, la vista operativa con el `Asset` patrimonial.
- `Interface`, `IpAddress`, `Subnet` y `Vlan` no existen en el modelo actual y quedan para una fase IPAM posterior.

### Agente y remoto

- `AgentDevice`, `AgentEnrollmentToken`.
- `AgentInventorySnapshot`, `AgentMetricSample`.
- `RemoteSession`, `DeviceVncCredential`.
- No existen aún `Alert`, `AlertRule`, `AgentCommand` ni sesión JIT con motivo/ticket/TTL; requieren diseño y migración posteriores.

### Reglas de integridad

- `Asset` es la única raíz patrimonial; `NetworkDevice` es la capa operativa y puede vincularse 1:1 a un activo.
- `assetTag`, serie, `PhoneLine.phoneNumber` e ICCID respetan las unicidades actuales; MAC e IP de gestión se normalizan y validan en el service.
- Una asignación activa se cierra, no se sobrescribe.
- `PurchaseItem` conserva descripción, cantidad y precio histórico.
- Las entidades con `isActive`/`deletedAt` usan baja lógica; `NetworkLink` puede borrarse físicamente dejando snapshot en `AuditLog.meta`.
- Importaciones y heartbeats son idempotentes.

## 7. Intervalos, alertas y retención

### Intervalos iniciales

| Fuente | Dato | Intervalo |
|---|---|---:|
| Agente | Heartbeat y salud básica | 5 min |
| Agente | Inventario estático | al arranque, ante cambio y cada 12 h |
| Connector, posterior a Fase 1 | Heartbeat | 1 min |
| Red, posterior a Fase 1 | ICMP/disponibilidad | 60 s |
| Red, posterior a Fase 1 | Métricas SNMP | 5 min |
| Red, posterior a Fase 1 | Inventario SNMP | 6 h |
| Red, posterior a Fase 1 | LLDP/topología | 15 min |
| UniFi, posterior a Fase 1 | Estado operativo | 5 min |
| UniFi, posterior a Fase 1 | Inventario | 6 h |
| Cámaras, posterior a Fase 1 | Disponibilidad | 2 min |
| Cámaras, posterior a Fase 1 | Inventario básico | 24 h |

Los intervalos de red sólo se activan en la fase de descubrimiento. Se aplicarán jitter y límites de concurrencia para evitar picos.

### Umbrales iniciales

- PC stale: condición calculada si `lastSeenAt` supera 15 minutos; el valor persistido sigue siendo `AgentConnState.OFFLINE`.
- Servidor stale: warning calculado a 10 minutos y crítico a 20 minutos.
- Disco: warning con menos de 15% libre, crítico con menos de 8%.
- Salud/ciclos de batería no están en el modelo actual; el primer corte muestra porcentaje y carga, y la degradación queda para después.
- Red/cámara caída, desde Fase 2: tres fallos consecutivos antes de notificar.
- Garantía y mantenimiento: recordatorios a 30, 15 y 7 días; contratos requieren un modelo posterior.
- En el primer corte, `Notification` se deduplica por tipo, entidad y ventana de tiempo. Ciclo de vida de alerta abierta/acknowledged/recovered requiere el modelo futuro de alertas.

### Canales

- Centro de avisos basado en `Notification` para el primer corte.
- Email inmediato para críticos y configurable para warnings.
- WhatsApp se agregará mediante adapter separado; no se acoplará el dominio de alertas a un proveedor.

### Retención por defecto

| Dato | Retención |
|---|---:|
| `AgentMetricSample` | 14 días, según diseño Prisma actual |
| `AgentInventorySnapshot` | últimas 30 por dispositivo |
| Avisos `Notification` | 2 años o hasta purga de usuario, sujeto a política |
| Metadata `RemoteSession` | 2 años desde Fase 3 |
| Auditoría | 5 años |
| Activos, asignaciones y mantenimientos | vida del activo + 5 años |
| Compras y documentos asociados | 10 años, sujeto a política contable |
| Logs técnicos sin valor de auditoría | 30 días |

No se retienen capturas, video, teclas ni grabaciones de sesiones remotas.

Retener métricas por 90 días y agregados por dos años requiere una tabla/servicio de agregación posterior; no forma parte del esquema del primer corte.

## 8. Seguridad

### Google Workspace

- Validar firma, `iss`, `aud`, expiración, `email_verified` y `hd=grf.com.ar`.
- Usar el claim `sub` como identidad estable y persistirlo en `User.googleId`; el email puede cambiar.
- Exigir además pertenencia a la allowlist de tres usuarios IT.
- No solicitar Admin SDK para importar empleados: el Excel del ERP es la fuente.
- Cookies `HttpOnly`, `Secure`, `SameSite` y sesiones revocables.

### Datos y secretos

- TLS en todo tránsito y cifrado del proveedor en reposo.
- Credenciales de UniFi, SMTP y SSH mediante secret manager o `secretsRef`, nunca en campos libres, logs o frontend.
- En el primer corte, el password VNC se guarda únicamente en `DeviceVncCredential`, cifrado con AES-256-GCM y clave `IT_SECRETS_KEY` configurada como secreto de Render; migrar a un vault externo es una evolución recomendada.
- Adjuntos privados, con validación de tamaño/tipo, escaneo y URL firmada corta.
- Campos personales y exportaciones restringidos por permiso.
- Backup diario adicional y prueba trimestral de restauración, además de PITR de Neon si el plan lo permite.

### UltraVNC y remoto

El password común actual es un riesgo aceptado temporalmente, no el diseño objetivo. Antes de habilitar remoto se exige:

1. Rotar el password actual.
2. Guardarlo cifrado en `DeviceVncCredential`, nunca devolverlo por API y planificar su migración a un vault.
3. Restringir por firewall el puerto UltraVNC para aceptar sólo la IP de Guacamole.
4. Exigir LAN o VPN de IT para llegar al gateway.
5. TTL máximo inicial de 60 minutos y cierre explícito.
6. Motivo o ticket obligatorio.
7. No revelar el password al técnico.

Si un endpoint no tiene ruta por la VPN parcial, el sistema no ofrecerá un bypass público. Se deberá extender la VPN o incorporar posteriormente un túnel reverso autenticado. Para SSH se verificará siempre la host key y las credenciales serán por usuario o vault, nunca compartidas en la interfaz.

### Agente y Connector

- Identidad individual revocable y secreto individual hasheado en servidor; toda comunicación usa TLS.
- El agente no acepta conexiones entrantes.
- El Connector sólo ejecuta tipos de tarea permitidos y redes CIDR autorizadas.
- SNMPv3 read-only; SNMPv2 queda fuera salvo excepción documentada.
- El primer corte no contiene comandos ni shell arbitraria.
- Requests asimétricamente firmados, replay protection avanzada y catálogo de comandos auditables requieren modelos posteriores.

## 9. Fases

### Fase 0 — base técnica y datos

- Definir allowlist, roles, taxonomía, ubicaciones y columnas del Excel ERP.
- Organizar módulos de gestión IT sobre las rutas existentes `/it/*` y `/api/it/*`, reutilizando los modelos Prisma actuales.
- Configurar object storage, email y auditoría.
- Preparar pipeline de importación con dry-run.

### Fase 1 — primer corte productivo

- Login Workspace y permisos.
- Personas importadas desde ERP.
- Inventario, asignaciones, celulares/líneas, mantenimiento, compras y proveedores.
- Inventario y topología de red manuales.
- Cámaras como `NetworkDevice(type=CAMERA)`, sin video; vínculo patrimonial opcional a `Asset`.
- Integración por vínculo con tickets.
- Avisos `Notification` + email para vencimientos y mantenimiento.
- Piloto read-only del agente en cinco PCs y un servidor.
- Dashboard, búsqueda, exportación controlada y auditoría.

### Fase 2 — telemetría y red

- Despliegue del agente a las 60 PCs y servidores aprobados.
- OPS Connector en Proxmox.
- Disponibilidad de dispositivos y cámaras.
- Integración UniFi read-only.
- SNMPv3, LLDP, reconciliación de topología y reglas de salud.

### Fase 3 — acceso remoto

- Guacamole/guacd en Proxmox y reverse proxy interno.
- Hardening del password común de UltraVNC y firewall.
- Ampliación de `RemoteSession` para motivo/ticket/TTL y luego sesiones JIT de VNC/SSH con auditoría.
- Habilitación sólo para destinos alcanzables desde LAN/VPN.

### Fase 4 — ampliaciones

- WhatsApp, contratos/licencias, stock avanzado, automatizaciones aprobadas y túnel reverso si la VPN no puede completarse.
- Evaluar integración con Zabbix/LibreNMS antes de construir monitoreo de alta frecuencia propio.

## 10. Criterios de aceptación del primer corte

El primer corte se considera aceptado únicamente cuando se cumplen todos los puntos siguientes.

### Identidad

- Un usuario Google de `grf.com.ar` incluido en la allowlist puede ingresar.
- Un Gmail personal, otro dominio y un empleado `grf.com.ar` fuera de la allowlist son rechazados.
- `USER` no accede a `/it/*`; `AGENT` opera el módulo sin autorizar compras ni gestionar credenciales y `ADMIN` posee esas capacidades.
- Los roles `OPS_*` no son requisito del primer corte y sólo podrán introducirse con una migración futura.
- Cierre de sesión y revocación invalidan la sesión activa.

### Personas e importación

- Se puede previsualizar un Excel representativo de 90 empleados sin modificar producción.
- La vista previa informa altas, cambios, bajas lógicas, duplicados y filas inválidas.
- Ejecutar dos veces el mismo archivo no crea duplicados.
- Un empleado importado no obtiene login.

### Inventario y móviles

- Se pueden registrar o importar las 60 PCs, 100 celulares, servidores, 25 equipos de red y 40 cámaras.
- La búsqueda encuentra por etiqueta, persona, serie, hostname, IP, MAC, IMEI y número de línea.
- Reasignar un activo cierra la asignación anterior y preserva su historia.
- Celular y línea pueden reasignarse sin perder trazabilidad; el ICCID actual queda en `PhoneLine` y no se promete historial independiente de SIM.
- El sistema detecta duplicados normalizados de serie, IMEI, ICCID, MAC y etiqueta.

### Mantenimiento y compras

- Un técnico puede programar y completar un `Maintenance` con descripción, repuestos JSON, costo y ticket.
- El timeline del activo refleja el mantenimiento sin edición destructiva del pasado.
- Una compra registra `Supplier`, justificación, adjuntos de presupuesto/factura/remito, moneda, total, tipo de cambio y autorizador.
- Sólo un `ADMIN` puede pasar una compra a `APPROVED`; el primer corte no incluye aprobación multinivel ni motor de cotizaciones.
- La recepción de una línea de compra puede originar uno o varios activos.

### Red

- Los 25 dispositivos y 40 cámaras pueden ubicarse, direccionarse y representarse manualmente en la topología.
- Cada dispositivo conserva `managementIp`, MAC, VLANs y ubicación; cada enlace conserva extremos, puertos, tipo, VLANs y velocidad según el modelo actual.
- Cámaras usan `NetworkDeviceType.CAMERA`; no se exige un `AssetType.CAMERA` inexistente.
- IPAM estructurado con interfaces/subredes y estado de disponibilidad calculado queda para Fase 2 o posterior.

### Agente piloto

- Cinco PCs y un Server 2016/2019 se enrolan con identidad individual.
- Reportan hostname, OS, IP/MAC, uptime, CPU, memoria, disco y batería cuando exista.
- Reiniciar el equipo o servicio no duplica el agente.
- Un agente con `isActive=false` deja de poder publicar.
- Tras superar el umbral, la UI muestra la condición stale calculada aunque el enum persistido sea `OFFLINE`.
- No existe endpoint ni acción para shell o PowerShell arbitrario.

### Alertas, archivos, auditoría y tickets

- Vencimientos y condiciones del piloto crean `Notification` deduplicada y notifican por email según severidad; acknowledgements y recuperaciones formales quedan para el modelo de alertas futuro.
- Los `PurchaseAttachment` no son públicos; `storageUrl` referencia el objeto privado y la descarga se entrega mediante URL firmada temporal.
- Cada alta, cambio, exportación, aprobación e importación genera un evento auditable con correlation ID.
- `Ticket.assetId` y `Maintenance.ticketId` vinculan tickets con activos/mantenimientos sin tabla paralela.

### Operación

- Listados y búsqueda comunes responden en menos de dos segundos en el volumen inicial, excluyendo latencia excepcional de proveedores.
- Si falla email, el evento se reintenta sin duplicar la operación de negocio.
- Existe backup automatizado y se documenta una restauración de prueba.
- Las migraciones pueden ejecutarse primero en staging y tienen estrategia de rollback compatible.
- La función de acceso remoto permanece deshabilitada por feature flag hasta completar los controles de la Fase 3.

## 11. Bloqueos previos a cada hito

Antes de iniciar Fase 1:

- Confirmar los tres emails autorizados.
- Acordar plantilla y clave única del Excel ERP.
- Definir catálogo inicial de tipos, estados, ubicaciones y centros de costo.
- Elegir object storage y proveedor de email.

Antes de iniciar Fase 2:

- Crear cuenta read-only para UniFi.
- Acordar CIDR permitidos y credenciales SNMPv3.
- Definir instalación del agente por GPO, script firmado o procedimiento manual.
- Validar el agente contra antivirus/EDR.

Antes de iniciar Fase 3:

- Completar firewall hacia UltraVNC y rotar el password común.
- Definir ruta LAN/VPN para los tres IT.
- Aprobar la política explícita de no grabación y no consentimiento.
- Inventariar qué equipos realmente ofrecen SSH y sus host keys.
