# Diseño unificado — Módulos de Gestión IT

> Documento consolidado a partir de 5 diseños técnicos + 1 revisión de coherencia.
> Los conflictos entre diseños se resolvieron aplicando los 13 fixes del revisor.
> Base: sistema de tickets existente en producción.
> Backend: `C:/Users/Illei/source/sistema-tickets-back` (Node 20 + TypeScript + Express 4 + Prisma 6 + PostgreSQL 15, roles USER/AGENT/ADMIN, JWT + `requireRole`).
> Frontend: `C:/Users/Illei/source/sistema-tickets-front` (React + Vite + Tailwind, themes por tokens HSL con `data-theme` + `.dark`).

---

## 1. Resumen ejecutivo

Se extiende el sistema de tickets interno con una **sección de Gestión IT** exclusiva para el equipo técnico (roles AGENT/ADMIN), compuesta por cinco módulos:

1. **Inventario, mantenimientos, compras y proveedores**: ciclo de vida completo del equipamiento (se compra → ingresa → se asigna → se mantiene → se da de baja), con órdenes de compra autorizadas por ADMIN, adjuntos de facturas y trazabilidad hasta el ticket que originó cada reparación.
2. **Personal y líneas de celular**: padrón de personas físicas (`Person`, con o sin cuenta de sistema) y gestión de líneas corporativas con historial de tenencia, costos por operadora y PUK cifrado.
3. **Red y topología**: inventario de dispositivos de red por sitio físico, enlaces entre equipos y editor visual de topología con React Flow y layouts persistidos.
4. **Agente de monitoreo + acceso remoto**: agente en Go como servicio de Windows que reporta por WebSocket saliente (heartbeat, inventario, métricas con retención acotada), y pasarelas auditadas de SSH web (xterm.js + ssh2) y VNC (visor local en Fase 1, noVNC en Fase 2).
5. **Frontend IT + theme "Dystopia"**: árbol de rutas canónico `/it/*`, navegación con grupo "Gestión IT", panel IT con agregador único, tercer theme estilo terminal CRT y code-splitting de las librerías nuevas.

**Principio rector**: todo el cambio de base de datos es **aditivo** (tablas nuevas + relaciones inversas sin columna; la única columna nueva en tablas existentes es `tickets.asset_id` nullable), seguro para `prisma db push` en producción. El schema se consolida en **una sola edición** de `prisma/schema.prisma` y **un solo push**.

**Decisiones estructurales tomadas por la revisión de coherencia** (detalladas en cada sección):
- La tenencia física de equipos y líneas se unifica en `Person` (no en `User`); los campos de trazabilidad de operadores IT siguen apuntando a `User`.
- `Asset` es el hub de integración: incorpora las 4 relaciones inversas que asumen los otros módulos (`phoneLines`, `phoneLineAssignments`, `networkDevice`, `agentDevice`).
- Un único enum `Currency` para compras, mantenimientos y líneas.
- Árbol de rutas front canónico `/it/*` (diseño front), un solo dashboard IT, una sola modificación a la navegación y protección de rutas en un único route padre.
- Política única de secretos: referencia externa (`secretsRef`) por defecto; cifrado AES-256-GCM con **una** clave maestra (`IT_SECRETS_KEY`) y formato único `cipherText/iv/authTag/keyVersion` cuando el negocio exige persistir un secreto (PUK de SIM, password VNC).

---

## 2. Schema Prisma unificado

Un solo bloque coherente. Convenciones del schema real respetadas: ids `cuid()`, enums en MAYÚSCULAS, `@@map` snake_case en todos los modelos, `isActive`/`deletedAt` para bajas lógicas.

```prisma
// ============================================================================
// MÓDULOS DE GESTIÓN IT — SCHEMA UNIFICADO (100% aditivo, un solo db push)
// Única columna nueva en tablas existentes: tickets.asset_id (nullable).
// ============================================================================

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

enum AssetType {
  DESKTOP        // PC de escritorio
  NOTEBOOK
  PHONE          // celular corporativo
  TABLET
  MONITOR
  PRINTER
  PERIPHERAL     // teclado, mouse, headset, webcam, etc.
  NETWORK_DEVICE // router, switch, access point (capa patrimonial)
  SERVER
  OTHER
}

enum AssetStatus {
  IN_STOCK   // en depósito IT, sin asignar
  ASSIGNED   // asignado a persona y/o sector
  IN_REPAIR  // en mantenimiento / reparación
  RETIRED    // dado de baja
  LOST       // extraviado o robado
}

enum MaintenanceType {
  PREVENTIVE
  CORRECTIVE
  UPGRADE
}

enum MaintenanceStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
}

// Enum ÚNICO de moneda: lo consumen Purchase, Maintenance y PhoneLine.
enum Currency {
  ARS
  USD
}

enum PurchaseStatus {
  REQUESTED  // cargada, pendiente de autorización
  APPROVED   // autorizada por ADMIN
  ORDERED    // pedida al proveedor
  RECEIVED   // recibida: habilita el alta de Assets desde los items
  CANCELLED
}

enum EmploymentStatus {
  ACTIVE      // trabajando actualmente
  ON_LEAVE    // licencia prolongada
  TERMINATED  // desvinculado (se conserva por historial de asignaciones)
}

enum PhoneCarrier {
  CLARO
  MOVISTAR
  PERSONAL
  TUENTI
  OTHER       // usar carrierOther para el nombre
}

enum PhoneLineStatus {
  ACTIVE      // operativa y en uso
  AVAILABLE   // operativa pero sin titular (pool disponible)
  SUSPENDED   // suspendida temporalmente ante la operadora
  CANCELLED   // dada de baja definitiva ante la operadora
}

enum NetworkDeviceType {
  ROUTER
  SWITCH
  ACCESS_POINT
  FIREWALL
  SERVER
  NAS
  PRINTER      // impresora de red
  CAMERA       // cámara IP
  UPS
  OTHER
}

enum NetworkDeviceStatus {
  ACTIVE       // operativo
  INACTIVE     // apagado / fuera de servicio temporal
  MAINTENANCE  // en mantenimiento
  RETIRED      // dado de baja (se conserva como histórico)
}

enum NetworkLinkType {
  ETHERNET   // cobre
  FIBER      // fibra óptica
  WIFI       // enlace inalámbrico
  WAN        // enlace de proveedor entre sitios
  VPN        // túnel lógico
  VIRTUAL    // LAG / trunk lógico u otro enlace no físico
  OTHER
}

enum AgentConnState {
  ONLINE
  OFFLINE
}

enum RemoteSessionKind {
  SSH
  VNC
}

enum RemoteSessionStatus {
  ACTIVE
  CLOSED
  ERROR
}

// ---------------------------------------------------------------------------
// MÓDULO PERSONAL (base de la tenencia física de equipos y líneas)
// ---------------------------------------------------------------------------

// Persona física que trabaja en la empresa. NO todas tienen cuenta en el
// sistema: userId es opcional (1:1). Minimización de datos (Ley 25.326):
// SOLO datos laborales. NO cargar DNI, domicilio, contacto personal ni
// datos de salud. El contacto registrado es el laboral.
model Person {
  id             String           @id @default(cuid())
  employeeNumber String?          @unique // legajo RRHH; opcional (externos)
  firstName      String
  lastName       String
  jobTitle       String?
  workEmail      String?          @unique
  workPhone      String?
  status         EmploymentStatus @default(ACTIVE)
  startDate      DateTime?        // ingreso (onboarding IT)
  endDate        DateTime?        // egreso (dispara devolución de línea/equipo)
  notes          String?          @db.Text // UI: leyenda "no volcar datos sensibles"
  isActive       Boolean          @default(true)
  deletedAt      DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt

  departmentId String?
  department   Department? @relation(fields: [departmentId], references: [id], onDelete: SetNull)

  // Cuenta del sistema (opcional, única por persona).
  userId String? @unique
  user   User?   @relation("PersonAccount", fields: [userId], references: [id], onDelete: SetNull)

  // Tenencia unificada (fix del revisor): la persona es quien TIENE
  // el equipo y la línea, tenga o no cuenta de sistema.
  assignedAssets       Asset[]               @relation("AssetHolder")
  assetAssignments     AssetAssignment[]
  phoneLines           PhoneLine[]           @relation("LineHolder")
  phoneLineAssignments PhoneLineAssignment[]

  @@index([departmentId, status])
  @@index([lastName, firstName])
  @@map("people")
}

// ---------------------------------------------------------------------------
// MÓDULO INVENTARIO + MANTENIMIENTOS + COMPRAS + PROVEEDORES
// ---------------------------------------------------------------------------

// Equipo físico del inventario IT (capa PATRIMONIAL: compra, garantía,
// serie, asignación). Lo operativo de red vive en NetworkDevice.
model Asset {
  id           String      @id @default(cuid())
  // Código interno único (etiqueta física). Lo genera el service:
  // prefijo por tipo + correlativo, ej "NB-0042". Editable solo por ADMIN.
  assetTag     String      @unique
  type         AssetType
  status       AssetStatus @default(IN_STOCK)
  brand        String
  model        String
  serialNumber String?     @unique
  // Specs flexibles: { cpu, ramGb, storage, os, imei, mac, ... }.
  // PROHIBIDO guardar contraseñas/credenciales acá (usar secretsRef).
  // PROHIBIDO guardar número de línea / ICCID acá (viven en PhoneLine;
  // la validación Zod rechaza claves linea/phoneNumber/iccid).
  // El IMEI SÍ va acá: es atributo del aparato, no de la línea.
  specs        Json?
  notes        String?     @db.Text
  // Referencia externa al gestor de secretos (ej. id de item en
  // Bitwarden/Vault). Nunca la credencial en sí.
  secretsRef   String?
  location     String?     // ubicación física libre
  warrantyUntil DateTime?  // vencimiento de garantía

  // Asignación VIGENTE denormalizada (historial completo en AssetAssignment).
  // Tenencia unificada en Person (fix del revisor).
  assignedPersonId     String?
  assignedPerson       Person?     @relation("AssetHolder", fields: [assignedPersonId], references: [id], onDelete: SetNull)
  assignedDepartmentId String?
  assignedDepartment   Department? @relation("AssetDepartment", fields: [assignedDepartmentId], references: [id], onDelete: SetNull)

  // Origen de compra (null = alta manual de inventario preexistente).
  purchaseItemId String?
  purchaseItem   PurchaseItem? @relation(fields: [purchaseItemId], references: [id], onDelete: SetNull)

  // Baja de ciclo de vida (RETIRED queda visible; deletedAt es para
  // cargas erróneas).
  retiredAt        DateTime?
  retirementReason String?

  isActive  Boolean   @default(true)
  deletedAt DateTime?

  createdById String
  createdBy   User     @relation("AssetCreator", fields: [createdById], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  assignments  AssetAssignment[]
  maintenances Maintenance[]
  tickets      Ticket[]

  // Back-relations que asumen los otros módulos (fix del revisor:
  // centralizadas acá, campos de relación puros, sin columna).
  phoneLines           PhoneLine[]
  phoneLineAssignments PhoneLineAssignment[]
  networkDevice        NetworkDevice?
  agentDevice          AgentDevice?

  @@index([status, type])
  @@index([assignedPersonId])
  @@index([assignedDepartmentId])
  @@index([warrantyUntil])
  @@map("assets")
}

// Historial de asignaciones. endAt = null es la vigente (a lo sumo una
// por asset, lo garantiza el service dentro de $transaction).
model AssetAssignment {
  id      String @id @default(cuid())
  assetId String
  asset   Asset  @relation(fields: [assetId], references: [id], onDelete: Cascade)

  // Persona y/o sector: al menos uno de los dos (lo valida Zod/service).
  personId     String?
  person       Person?     @relation(fields: [personId], references: [id], onDelete: SetNull)
  departmentId String?
  department   Department? @relation("AssetAssignmentDepartment", fields: [departmentId], references: [id], onDelete: SetNull)

  // Operador IT que registró el movimiento (siempre tiene cuenta → User).
  assignedById String
  assignedBy   User   @relation("AssetAssignmentGiver", fields: [assignedById], references: [id])

  startAt    DateTime  @default(now())
  endAt      DateTime? // null = vigente
  note       String?
  returnNote String?   // estado al devolver

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([assetId, endAt])
  @@index([personId])
  @@index([departmentId])
  @@map("asset_assignments")
}

// Mantenimiento preventivo / correctivo / upgrade sobre un Asset.
model Maintenance {
  id      String @id @default(cuid())
  assetId String
  asset   Asset  @relation(fields: [assetId], references: [id], onDelete: Cascade)

  type   MaintenanceType
  status MaintenanceStatus @default(SCHEDULED)

  scheduledAt DateTime? // planificada (preventivos)
  performedAt DateTime? // ejecución real
  description String    @db.Text

  // Quién lo hizo: técnico interno (User) y/o proveedor externo.
  performedById String?
  performedBy   User?     @relation("MaintenancePerformer", fields: [performedById], references: [id], onDelete: SetNull)
  supplierId    String?
  supplier      Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)

  costAmount Decimal? @db.Decimal(14, 2)
  currency   Currency @default(ARS)
  parts      Json?    // repuestos: [{ name, qty, cost }]

  // Ticket que originó el correctivo (opcional).
  ticketId String?
  ticket   Ticket? @relation(fields: [ticketId], references: [id], onDelete: SetNull)

  createdById String
  createdBy   User     @relation("MaintenanceCreator", fields: [createdById], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([assetId, performedAt])
  @@index([status, scheduledAt])
  @@index([supplierId])
  @@index([ticketId]) // FK sin índice automático en Postgres; el detalle de Ticket lista sus mantenimientos
  @@map("maintenances")
}

// Proveedor de hardware, insumos o servicio técnico.
model Supplier {
  id          String  @id @default(cuid())
  name        String  @unique
  cuit        String? @unique
  contactName String?
  email       String?
  phone       String?
  website     String?
  address     String?
  categories  String[] // ["hardware", "insumos", "servicio técnico"]
  notes       String? @db.Text

  isActive  Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  purchases    Purchase[]
  maintenances Maintenance[]

  @@index([isActive])
  @@map("suppliers")
}

// Compra de equipamiento / insumos IT.
// Flujo: REQUESTED -> APPROVED (ADMIN) -> ORDERED -> RECEIVED (alta de Assets).
model Purchase {
  id             String         @id @default(cuid())
  purchaseNumber Int            @unique @default(autoincrement()) // "OC-123"
  status         PurchaseStatus @default(REQUESTED)

  supplierId String?
  supplier   Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)

  currency     Currency @default(ARS)
  totalAmount  Decimal  @db.Decimal(14, 2)  // denormalizado, lo recalcula el service
  exchangeRate Decimal? @db.Decimal(12, 4)  // cotización ARS/USD de referencia

  justification String  @db.Text  // obligatoria: por qué se decidió comprar
  invoiceNumber String?
  notes         String? @db.Text

  requestedById  String
  requestedBy    User      @relation("PurchaseRequester", fields: [requestedById], references: [id])
  authorizedById String?
  authorizedBy   User?     @relation("PurchaseAuthorizer", fields: [authorizedById], references: [id], onDelete: SetNull)
  authorizedAt   DateTime?

  orderedAt  DateTime?
  receivedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  items       PurchaseItem[]
  attachments PurchaseAttachment[]

  @@index([status, createdAt])
  @@index([supplierId])
  @@map("purchases")
}

// Renglón de la compra. Al marcar RECEIVED, el service genera N Assets
// por cada item inventariable (los insumos no generan Asset).
model PurchaseItem {
  id         String   @id @default(cuid())
  purchaseId String
  purchase   Purchase @relation(fields: [purchaseId], references: [id], onDelete: Cascade)

  description String
  quantity    Int     @default(1)
  unitPrice   Decimal @db.Decimal(14, 2)
  assets      Asset[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([purchaseId])
  @@map("purchase_items")
}

// Adjuntos de la compra (factura, presupuesto, remito). Modelo aparte
// porque el Attachment existente está atado a Ticket con FK obligatoria.
model PurchaseAttachment {
  id         String   @id @default(cuid())
  purchaseId String
  purchase   Purchase @relation(fields: [purchaseId], references: [id], onDelete: Cascade)

  fileName   String
  mimeType   String
  sizeBytes  Int
  storageUrl String

  uploadedById String
  uploadedBy   User     @relation("PurchaseAttachmentUploader", fields: [uploadedById], references: [id])
  createdAt    DateTime @default(now())

  @@index([purchaseId])
  @@map("purchase_attachments")
}

// ---------------------------------------------------------------------------
// MÓDULO LÍNEAS DE CELULAR
// ---------------------------------------------------------------------------

// Línea de celular corporativa. holder = Person que la usa HOY (el service
// lo sincroniza con el assignment abierto). asset = celular que porta la SIM.
model PhoneLine {
  id             String          @id @default(cuid())
  // Formato E.164, ej "+5493415551234". Único: si la operadora recicla un
  // número dado de baja, se REACTIVA el registro CANCELLED (no fila nueva).
  phoneNumber    String          @unique
  carrier        PhoneCarrier
  carrierOther   String?
  planName       String?
  monthlyCost    Decimal?        @db.Decimal(10, 2)
  currency       Currency        @default(ARS)   // enum compartido (fix del revisor)
  simIccid       String?         @unique         // ICCID de la SIM actual (19-20 dígitos)
  // PUK cifrado con crypto.service.ts (AES-256-GCM, clave IT_SECRETS_KEY).
  // Formato unificado cipherText/iv/authTag/keyVersion (fix del revisor).
  // NUNCA en respuestas de list/detail; revelado solo ADMIN + AuditLog.
  pukCipherText  String?
  pukIv          String?
  pukAuthTag     String?
  pukKeyVersion  Int             @default(1)
  status         PhoneLineStatus @default(AVAILABLE)
  contractEndsAt DateTime?       // fin de permanencia / renovación
  notes          String?         @db.Text
  isActive       Boolean         @default(true)
  deletedAt      DateTime?
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  // Titular actual: Person (puede no tener cuenta de sistema).
  holderId String?
  holder   Person? @relation("LineHolder", fields: [holderId], references: [id], onDelete: SetNull)

  // Celular que porta la SIM.
  assetId String?
  asset   Asset?  @relation(fields: [assetId], references: [id], onDelete: SetNull)

  assignments PhoneLineAssignment[]

  @@index([status, carrier])
  @@index([holderId])
  @@index([assetId])
  @@map("phone_lines")
}

// Historial de asignación de líneas. Invariante (service, en transacción):
// a lo sumo UNA fila con returnedAt = null por línea. El hard delete de una
// Person (derecho de supresión, Ley 25.326) cascadea su historial.
model PhoneLineAssignment {
  id          String    @id @default(cuid())
  phoneLineId String
  personId    String
  assetId     String?   // celular al momento de la asignación (snapshot)
  assignedAt  DateTime  @default(now())
  returnedAt  DateTime? // null = vigente
  note        String?
  assignedById String   // operador IT (trazabilidad)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  phoneLine  PhoneLine @relation(fields: [phoneLineId], references: [id], onDelete: Cascade)
  person     Person    @relation(fields: [personId], references: [id], onDelete: Cascade)
  asset      Asset?    @relation(fields: [assetId], references: [id], onDelete: SetNull)
  assignedBy User      @relation("PhoneAssignmentActor", fields: [assignedById], references: [id])

  @@index([phoneLineId, assignedAt])
  @@index([personId])
  @@map("phone_line_assignments")
}

// ---------------------------------------------------------------------------
// MÓDULO RED + TOPOLOGÍA
// ---------------------------------------------------------------------------

// Sitio físico: planta, sucursal, depósito. El service rechaza el borrado
// si el sitio tiene dispositivos activos.
model Site {
  id          String    @id @default(cuid())
  name        String    @unique
  slug        String    @unique
  address     String?
  description String?
  isActive    Boolean   @default(true)
  deletedAt   DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  devices       NetworkDevice[]
  topologyViews NetworkTopologyView[]

  @@map("sites")
}

// Capa OPERATIVA de red (IP, VLANs, puertos, topología). Regla de doble
// capa (fix del revisor): Asset = patrimonial, NetworkDevice = operativo.
// Al crear un NetworkDevice el drawer ofrece vincular un Asset existente;
// el service emite warning (no bloqueante) si queda sin assetId.
model NetworkDevice {
  id           String              @id @default(cuid())
  name         String              // hostname o nombre descriptivo
  type         NetworkDeviceType
  status       NetworkDeviceStatus @default(ACTIVE)
  managementIp String?             // unicidad por sitio validada en service (solo activos)
  macAddress   String?             // normalizada AA:BB:CC:DD:EE:FF en el service
  vlans        String[]            // ej ["10", "20-VoIP"], formato validado en Zod
  location     String?             // rack, sala, piso
  adminUrl     String?             // Zod: solo http/https
  notes        String?             @db.Text
  // Nombre unificado con Asset.secretsRef (fix del revisor). Referencia a
  // la entrada del gestor de contraseñas. NUNCA usuario/clave en esta base.
  secretsRef   String?

  siteId String
  site   Site   @relation(fields: [siteId], references: [id])

  // Vínculo 1:1 opcional con la capa patrimonial.
  assetId String? @unique
  asset   Asset?  @relation(fields: [assetId], references: [id], onDelete: SetNull)

  isActive  Boolean   @default(true)
  deletedAt DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  linksA        NetworkLink[]                 @relation("LinkDeviceA")
  linksB        NetworkLink[]                 @relation("LinkDeviceB")
  nodePositions NetworkTopologyNodePosition[]

  @@index([siteId, type])
  @@index([isActive, status])
  @@index([managementIp])
  @@index([macAddress])
  @@map("network_devices")
}

// Enlace entre dos dispositivos. No direccional a nivel de negocio; el
// service normaliza deviceAId < deviceBId y rechaza self-links. Hard
// delete (el AuditLog conserva snapshot en meta).
model NetworkLink {
  id        String          @id @default(cuid())
  deviceAId String
  deviceBId String
  portA     String?         // ej "Gi0/1", "SFP+ 2"
  portB     String?
  type      NetworkLinkType @default(ETHERNET)
  vlans     String[]
  speedMbps Int?
  notes     String?
  createdAt DateTime        @default(now())
  updatedAt DateTime        @updatedAt

  deviceA NetworkDevice @relation("LinkDeviceA", fields: [deviceAId], references: [id], onDelete: Cascade)
  deviceB NetworkDevice @relation("LinkDeviceB", fields: [deviceBId], references: [id], onDelete: Cascade)

  @@unique([deviceAId, deviceBId, portA, portB])
  @@index([deviceAId])
  @@index([deviceBId])
  @@map("network_links")
}

// Vista de topología del editor React Flow. siteId null = vista global.
model NetworkTopologyView {
  id          String   @id @default(cuid())
  name        String
  description String?
  siteId      String?
  isDefault   Boolean  @default(false)
  viewport    Json?    // { x, y, zoom } de React Flow
  createdById String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  site      Site? @relation(fields: [siteId], references: [id], onDelete: SetNull)
  createdBy User  @relation("TopologyViewAuthor", fields: [createdById], references: [id])
  nodes     NetworkTopologyNodePosition[]

  @@index([siteId])
  @@map("network_topology_views")
}

// Posición x,y de un dispositivo en una vista (upsert masivo transaccional).
model NetworkTopologyNodePosition {
  id       String @id @default(cuid())
  viewId   String
  deviceId String
  x        Float
  y        Float

  view   NetworkTopologyView @relation(fields: [viewId], references: [id], onDelete: Cascade)
  device NetworkDevice       @relation(fields: [deviceId], references: [id], onDelete: Cascade)

  @@unique([viewId, deviceId])
  @@index([deviceId])
  @@map("network_topology_node_positions")
}

// ---------------------------------------------------------------------------
// MÓDULO AGENTE DE MONITOREO + ACCESO REMOTO
// ---------------------------------------------------------------------------

// Equipo con agente instalado. Identidad estable + secreto HASHEADO + set
// denormalizado "último valor conocido" que se sobreescribe por heartbeat.
model AgentDevice {
  id              String         @id @default(cuid())
  // MachineGuid de Windows (HKLM Cryptography/MachineGuid): permite
  // re-enrolar sin duplicar el equipo.
  machineId       String         @unique
  hostname        String
  // Secreto del agente para el WebSocket, HASHEADO (sha256). El valor
  // plano se muestra UNA sola vez al enrolar.
  secretHash      String
  agentVersion    String?
  osName          String?        // "Windows 11 Pro"
  osVersion       String?        // "10.0.26100"
  connState       AgentConnState @default(OFFLINE)
  lastSeenAt      DateTime?
  lastEnrolledAt  DateTime       @default(now())
  // --- Último valor conocido (overwrite, no genera filas) ---
  loggedInUser    String?
  primaryIp       String?
  primaryMac      String?
  uptimeSec       Int?
  cpuPct          Float?
  ramUsedMb       Int?
  ramTotalMb      Int?
  batteryPct      Int?
  batteryCharging Boolean?
  vncRunning      Boolean        @default(false) // UltraVNC detectado
  sshRunning      Boolean        @default(false) // OpenSSH Server detectado
  // --- Gestión ---
  isActive        Boolean        @default(true)  // false = agente revocado
  deletedAt       DateTime?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt

  // Vínculo 1:1 opcional con la capa patrimonial.
  assetId         String?        @unique
  asset           Asset?         @relation(fields: [assetId], references: [id], onDelete: SetNull)

  snapshots       AgentInventorySnapshot[]
  metrics         AgentMetricSample[]
  sessions        RemoteSession[]
  vncCredential   DeviceVncCredential?
  enrollmentToken AgentEnrollmentToken? @relation("TokenUsedBy")

  @@index([connState])
  @@index([hostname])
  @@index([lastSeenAt])
  @@map("agent_devices")
}

// Token de un solo uso para enrolamiento. Se guarda HASHEADO (sha256);
// el plano se muestra 1 sola vez. Vencimiento corto (ej 7 días).
model AgentEnrollmentToken {
  id             String    @id @default(cuid())
  tokenHash      String    @unique
  label          String?   // ej "Lote Contaduría 2026"
  expiresAt      DateTime
  usedAt         DateTime? // null = sin usar
  usedByDeviceId String?   @unique
  createdById    String
  createdAt      DateTime  @default(now())

  createdBy    User         @relation("EnrollTokenCreator", fields: [createdById], references: [id])
  usedByDevice AgentDevice? @relation("TokenUsedBy", fields: [usedByDeviceId], references: [id], onDelete: SetNull)

  @@index([expiresAt])
  @@map("agent_enrollment_tokens")
}

// Inventario COMPLETO periódico como JSON. Retención por cron
// (últimos 30 por equipo).
model AgentInventorySnapshot {
  id        String      @id @default(cuid())
  deviceId  String
  payload   Json
  createdAt DateTime    @default(now())

  device    AgentDevice @relation(fields: [deviceId], references: [id], onDelete: Cascade)

  @@index([deviceId, createdAt])
  @@map("agent_inventory_snapshots")
}

// Serie temporal DOWNSAMPLEADA (1 muestra cada 5 min). Única tabla que
// crece con el tiempo; se poda por cron (14 días).
model AgentMetricSample {
  id          String      @id @default(cuid())
  deviceId    String
  cpuPct      Float?
  ramUsedMb   Int?
  diskUsedPct Float?
  batteryPct  Int?
  sampledAt   DateTime    @default(now())

  device      AgentDevice @relation(fields: [deviceId], references: [id], onDelete: Cascade)

  @@index([deviceId, sampledAt])
  @@map("agent_metric_samples")
}

// Auditoría de cada sesión de acceso remoto. Complementa al AuditLog
// genérico (además se escribe ahí).
model RemoteSession {
  id         String              @id @default(cuid())
  deviceId   String
  userId     String              // operador IT que inició la sesión
  kind       RemoteSessionKind
  status     RemoteSessionStatus @default(ACTIVE)
  clientIp   String?             // IP del operador
  targetHost String?             // ip/host destino al momento de conectar
  startedAt  DateTime            @default(now())
  endedAt    DateTime?
  bytesIn    BigInt?
  bytesOut   BigInt?
  errorMsg   String?

  device     AgentDevice @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  user       User        @relation("RemoteSessionOperator", fields: [userId], references: [id])

  @@index([deviceId, startedAt])
  @@index([userId, startedAt])
  @@index([status])
  @@map("remote_sessions")
}

// Password de UltraVNC CIFRADA con crypto.service.ts (AES-256-GCM, clave
// única IT_SECRETS_KEY — fix del revisor). Nunca se devuelve por la API.
model DeviceVncCredential {
  id          String      @id @default(cuid())
  deviceId    String      @unique
  cipherText  String      // base64
  iv          String      // base64, nonce único por credencial
  authTag     String      // base64, tag GCM
  keyVersion  Int         @default(1) // habilita rotación de clave maestra
  vncPort     Int         @default(5900)
  updatedById String
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  device    AgentDevice @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  updatedBy User        @relation("VncCredentialEditor", fields: [updatedById], references: [id])

  @@map("device_vnc_credentials")
}

// ---------------------------------------------------------------------------
// MÓDULO FRONT: PREFERENCIAS DE UI
// ---------------------------------------------------------------------------

model UserUiPreference {
  id     String @id @default(cuid())
  userId String @unique
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  // "quiet-pro" | "workshop" | "dystopia" — validado con Zod en el service;
  // String (no enum) para sumar themes sin migración.
  theme String @default("quiet-pro")

  // null = seguir preferencia del sistema operativo.
  darkMode Boolean?

  // Orden/visibilidad de widgets del dashboard IT. JSON validado con Zod.
  itDashboardLayout Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("user_ui_preferences") // fix del revisor: faltaba el @@map
}
```

### 2.1 Modificaciones exactas a modelos EXISTENTES

Todas son campos de relación sin columna, salvo `tickets.asset_id` (única columna nueva, nullable → aditiva y segura).

**`model User` — agregar (14 relaciones, 0 columnas):**

```prisma
  // --- Gestión IT (trazabilidad de operadores; la tenencia vive en Person) ---
  createdAssets         Asset[]                @relation("AssetCreator")
  assetAssignmentsGiven AssetAssignment[]      @relation("AssetAssignmentGiver")
  maintenancesPerformed Maintenance[]          @relation("MaintenancePerformer")
  maintenancesCreated   Maintenance[]          @relation("MaintenanceCreator")
  purchasesRequested    Purchase[]             @relation("PurchaseRequester")
  purchasesAuthorized   Purchase[]             @relation("PurchaseAuthorizer")
  purchaseAttachments   PurchaseAttachment[]   @relation("PurchaseAttachmentUploader")
  personProfile         Person?                @relation("PersonAccount")
  phoneAssignmentsMade  PhoneLineAssignment[]  @relation("PhoneAssignmentActor")
  topologyViews         NetworkTopologyView[]  @relation("TopologyViewAuthor")
  enrollTokensCreated   AgentEnrollmentToken[] @relation("EnrollTokenCreator")
  remoteSessions        RemoteSession[]        @relation("RemoteSessionOperator")
  vncCredentialsEdited  DeviceVncCredential[]  @relation("VncCredentialEditor")
  uiPreference          UserUiPreference?
```

> Nota (fix del revisor): `assignedAssets` y `assetAssignments` del diseño original de inventario **no** van en `User` — la tenencia pasó a `Person`. `createdAssets` sí queda en `User`.

**`model Department` — agregar (3 relaciones, 0 columnas):**

```prisma
  // --- Gestión IT ---
  assignedAssets   Asset[]           @relation("AssetDepartment")
  assetAssignments AssetAssignment[] @relation("AssetAssignmentDepartment")
  people           Person[]
```

**`model Ticket` — agregar (1 columna nullable + 2 relaciones):**

```prisma
  // --- Gestión IT: equipo vinculado al ticket (única columna nueva) ---
  assetId      String?
  asset        Asset?        @relation(fields: [assetId], references: [id], onDelete: SetNull)
  maintenances Maintenance[]

  // FK sin índice automático en Postgres; la ficha de Asset lista sus tickets.
  @@index([assetId])
```

---

## 3. API — Endpoints por módulo

Convenciones (fix del revisor): los routers se montan en `src/routes/index.ts` **sin inventar prefijo `/api`** (el prefijo global lo aporta el mount existente de la app, igual que `/tickets`, `/projects`, etc.). Montaje: `router.use("/assets")`, `"/maintenances"`, `"/suppliers"`, `"/purchases"`, `"/people"`, `"/phone-lines"`, `"/network"`, `"/agents"`, `"/it-dashboard"`, `"/me/ui-preferences"`. Todos los routers llevan `authMiddleware + requireRole([UserRole.AGENT, UserRole.ADMIN])` a nivel `router.use` (firma verificada en `src/middleware/auth.ts`), con excepciones ADMIN-only por ruta y los endpoints del agente autenticados por token propio (sin JWT). Validación Zod en `src/validations/*` (patrón `projects.ts`: schemas create/update con `.partial()`, filtros con `z.coerce`, `pageSize <= 100`).

### 3.1 Inventario (`/assets`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/assets` | AGENT/ADMIN | Lista paginada; filtros q (tag/serie/marca/modelo), type, status, assignedPersonId, departmentId, warrantyBefore, includeInactive |
| GET | `/assets/stats` | AGENT/ADMIN | Contadores por estado/tipo, garantías por vencer, en reparación (lo consume el agregador del panel IT) |
| GET | `/assets/:id` | AGENT/ADMIN | Ficha completa: specs, asignación vigente, historial, mantenimientos, tickets, compra de origen, línea vinculada |
| POST | `/assets` | AGENT/ADMIN | Alta manual; genera assetTag correlativo por tipo en `$transaction` |
| PATCH | `/assets/:id` | AGENT/ADMIN | Edición (cambiar assetTag: solo ADMIN) |
| POST | `/assets/:id/assign` | AGENT/ADMIN | Asigna a personId y/o departmentId: cierra asignación vigente, crea AssetAssignment, status=ASSIGNED (todo en `$transaction`) |
| POST | `/assets/:id/unassign` | AGENT/ADMIN | Devuelve a stock con returnNote; status=IN_STOCK |
| POST | `/assets/:id/retire` | ADMIN | Baja de ciclo de vida: RETIRED + retiredAt + motivo obligatorio |
| GET | `/assets/:id/history` | AGENT/ADMIN | Historial de asignaciones desc |
| DELETE | `/assets/:id` | ADMIN | Soft delete (solo cargas erróneas) |

### 3.2 Mantenimientos (`/maintenances`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/maintenances` | AGENT/ADMIN | Lista con filtros (assetId, type, status, supplierId, from/to, page) |
| GET | `/maintenances/upcoming` | AGENT/ADMIN | Preventivos SCHEDULED próximos |
| GET | `/maintenances/:id` | AGENT/ADMIN | Detalle |
| POST | `/maintenances` | AGENT/ADMIN | Alta; `setAssetInRepair=true` pasa el Asset a IN_REPAIR en la misma transacción; ticketId opcional |
| PATCH | `/maintenances/:id` | AGENT/ADMIN | Actualizar/completar; al COMPLETED restaura el estado previo del Asset |
| DELETE | `/maintenances/:id` | ADMIN | Hard delete de registros erróneos |

### 3.3 Proveedores (`/suppliers`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/suppliers` | AGENT/ADMIN | Lista con filtros (q, category, isActive, page) |
| GET | `/suppliers/:id` | AGENT/ADMIN | Detalle con últimas compras y mantenimientos |
| POST | `/suppliers` | AGENT/ADMIN | Alta |
| PATCH | `/suppliers/:id` | AGENT/ADMIN | Edición |
| DELETE | `/suppliers/:id` | ADMIN | Soft delete (las compras históricas conservan la FK) |

### 3.4 Compras (`/purchases`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/purchases` | AGENT/ADMIN | Lista con filtros (q, status, supplierId, currency, from/to, page) |
| GET | `/purchases/:id` | AGENT/ADMIN | Detalle con items, adjuntos, solicitante/autorizante |
| POST | `/purchases` | AGENT/ADMIN | Crea en REQUESTED con items anidados y justificación obligatoria; el service calcula totalAmount. Permite alta directa en RECEIVED para carga histórica |
| PATCH | `/purchases/:id` | AGENT/ADMIN | Editar solo mientras status ∈ {REQUESTED, APPROVED}; recalcula total |
| POST | `/purchases/:id/authorize` | ADMIN | APPROVED; authorizedById desde `req.user.id` (nunca del body); notifica al solicitante |
| POST | `/purchases/:id/order` | AGENT/ADMIN | ORDERED + orderedAt |
| POST | `/purchases/:id/receive` | AGENT/ADMIN | RECEIVED; crea los Assets de cada item inventariable (serie, tag) en una sola `$transaction` |
| POST | `/purchases/:id/cancel` | AGENT/ADMIN (si estaba APPROVED: solo ADMIN) | CANCELLED con motivo |
| POST | `/purchases/:id/attachments` | AGENT/ADMIN | Sube factura/presupuesto (multipart; reutiliza fileValidation.service y storage actual) |
| DELETE | `/purchases/:id/attachments/:attachmentId` | ADMIN | Elimina adjunto |
| DELETE | `/purchases/:id` | ADMIN | Hard delete solo si status ∈ {REQUESTED, CANCELLED} |

### 3.5 Personal (`/people`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/people` | AGENT/ADMIN | Lista paginada; filtros q (nombre/legajo/email), departmentId, status, hasUser |
| GET | `/people/:id` | AGENT/ADMIN | Ficha: datos laborales, sector, User vinculado, equipos y líneas vigentes, historial |
| POST | `/people` | AGENT/ADMIN | Alta (`src/validations/people.ts`) |
| PATCH | `/people/:id` | AGENT/ADMIN | Edición parcial; vincular/desvincular userId (valida unicidad) y departmentId |
| DELETE | `/people/:id` | ADMIN | Baja lógica; 409 si tiene equipos o líneas con asignación vigente |

### 3.6 Líneas de celular (`/phone-lines`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/phone-lines` | AGENT/ADMIN | Lista con filtros (status, carrier, holderId, q, unassigned); nunca serializa campos de PUK |
| GET | `/phone-lines/stats` | AGENT/ADMIN | Costo mensual total, desglose por operadora/sector, conteo por estado |
| GET | `/phone-lines/:id` | AGENT/ADMIN | Detalle + titular + asset + historial (sin PUK) |
| POST | `/phone-lines` | AGENT/ADMIN | Alta (Zod: E.164, ICCID 19-20 dígitos, monthlyCost >= 0) |
| PATCH | `/phone-lines/:id` | AGENT/ADMIN | Plan, costo, estado, contractEndsAt, assetId, simIccid (SIM swap → AuditLog `sim_swapped`) |
| POST | `/phone-lines/:id/assign` | AGENT/ADMIN | `{personId, assetId?, note?}`: en transacción cierra assignment abierto, crea el nuevo, holderId + status=ACTIVE; notifica al User vinculado si existe |
| POST | `/phone-lines/:id/unassign` | AGENT/ADMIN | Cierra assignment abierto; holderId=null, status=AVAILABLE |
| GET | `/phone-lines/:id/assignments` | AGENT/ADMIN | Historial paginado |
| PUT | `/phone-lines/:id/puk` | ADMIN | Setea/actualiza PUK (cifra server-side con crypto.service) |
| GET | `/phone-lines/:id/puk` | ADMIN | Revela el PUK descifrado; AuditLog `puk_viewed` |
| DELETE | `/phone-lines/:id` | ADMIN | Baja lógica; exige CANCELLED o sin titular vigente |

### 3.7 Red y topología (`/network`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/network/sites` | AGENT/ADMIN | Sitios activos con conteo de dispositivos |
| POST | `/network/sites` | AGENT/ADMIN | Alta (slug autogenerado) |
| PATCH | `/network/sites/:id` | AGENT/ADMIN | Edición |
| DELETE | `/network/sites/:id` | ADMIN | Soft delete; 409 si tiene dispositivos activos |
| GET | `/network/devices` | AGENT/ADMIN | Lista paginada; filtros q (nombre/IP/MAC), type, status, siteId, vlan, includeInactive |
| GET | `/network/devices/:id` | AGENT/ADMIN | Detalle con site, asset vinculado y enlaces |
| POST | `/network/devices` | AGENT/ADMIN | Alta; IP única por sitio (activos), normaliza MAC, adminUrl http/https. + AuditLog |
| PATCH | `/network/devices/:id` | AGENT/ADMIN | Edición (incluye vincular/desvincular assetId). + AuditLog |
| DELETE | `/network/devices/:id` | ADMIN | Soft delete + RETIRED; borra enlaces y posiciones en la misma transacción. + AuditLog |
| GET | `/network/links?siteId&deviceId` | AGENT/ADMIN | Lista enlaces |
| POST | `/network/links` | AGENT/ADMIN | Alta; rechaza self-link y par de puertos duplicado. + AuditLog |
| PATCH | `/network/links/:id` | AGENT/ADMIN | Edición. + AuditLog |
| DELETE | `/network/links/:id` | AGENT/ADMIN | Hard delete (snapshot en AuditLog.meta) |
| GET | `/network/topology/views` | AGENT/ADMIN | Lista vistas |
| POST | `/network/topology/views` | AGENT/ADMIN | Crea vista; si siteId viene, siembra nodos en grilla |
| GET | `/network/topology/views/:id` | AGENT/ADMIN | Payload listo para React Flow (nodes/edges/viewport) |
| PUT | `/network/topology/views/:id/layout` | AGENT/ADMIN | Guarda layout completo (máx 500 nodos), transaccional, control optimista por `ifUpdatedAt` (409) |
| POST | `/network/topology/views/:id/nodes` | AGENT/ADMIN | Agrega dispositivo a la vista |
| DELETE | `/network/topology/views/:id/nodes/:deviceId` | AGENT/ADMIN | Quita el dispositivo de la vista |
| PATCH | `/network/topology/views/:id` | AGENT/ADMIN | Renombrar / description / isDefault (desmarca las demás en transacción) |
| DELETE | `/network/topology/views/:id` | ADMIN | Hard delete de la vista (cascade a posiciones) |

### 3.8 Agente y acceso remoto (`/agents`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/agents/enroll-tokens` | AGENT/ADMIN | Genera token de un solo uso (plano visible UNA vez) |
| GET | `/agents/enroll-tokens` | AGENT/ADMIN | Lista tokens (sin valor plano) |
| DELETE | `/agents/enroll-tokens/:id` | ADMIN | Revoca token no usado |
| POST | `/agents/enroll` | AGENTE (token, sin JWT, rate-limited) | Canjea token; upsert por machineId; devuelve `deviceId + agentSecret` (una vez) y parámetros |
| GET | `/agents/ws` | AGENTE (headers `x-device-id` + `x-agent-secret`) | Upgrade a WebSocket del hub |
| GET | `/agents/devices` | AGENT/ADMIN | Lista con connState, filtros estado/hostname/sector/asset |
| GET | `/agents/devices/:id` | AGENT/ADMIN | Detalle: último valor conocido + último snapshot + flags vnc/ssh (credencial nunca expuesta) |
| GET | `/agents/devices/:id/metrics?range=24h\|7d` | AGENT/ADMIN | Serie temporal para gráficos |
| GET | `/agents/devices/:id/snapshots` | AGENT/ADMIN | Historial de inventarios paginado |
| POST | `/agents/devices/:id/request-inventory` | AGENT/ADMIN | Comando on-demand por el WS si está online |
| PATCH | `/agents/devices/:id` | AGENT/ADMIN | Vincular/desvincular assetId, notas |
| DELETE | `/agents/devices/:id` | ADMIN | Soft delete + revoca el agente (isActive=false) |
| PUT | `/agents/devices/:id/vnc-credential` | ADMIN | Set/rotación de password VNC (cifrada; nunca se devuelve) |
| GET | `/agents/devices/:id/ssh` | AGENT/ADMIN (panel) | Upgrade a WS: pasarela SSH (ssh2). RemoteSession + AuditLog |
| GET | `/agents/devices/:id/vnc` | AGENT/ADMIN (panel, Fase 2) | Upgrade a WS: proxy TCP→WS al 5900 para noVNC. RemoteSession + AuditLog |
| GET | `/agents/devices/:id/vnc-launch` | AGENT/ADMIN (panel, Fase 1) | Archivo `.vnc` efímero (sin password) para visor local. RemoteSession + AuditLog |
| GET | `/agents/sessions` | AGENT/ADMIN | Auditoría de sesiones (AGENT ve las propias; ADMIN todas) |
| POST | `/agents/sessions/:id/end` | AGENT/ADMIN | Corta sesión activa (ADMIN o el propio operador) |

### 3.9 Panel IT y preferencias (`/it-dashboard`, `/me/ui-preferences`)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/it-dashboard/summary` | AGENT/ADMIN | Agregador único (una request, refetch 30s): `{ devices: {online, offline, total, lastDown[]}, hardwareAlerts[], maintenance: {overdue[], next7Days[]}, warranties: {expiring90Days[]}, mobileLines: {monthlyCostTotal, last6Months[], top5[]}, itOpenTickets }`. Reutiliza los services de stats de cada módulo (no hace N requests HTTP) |
| GET | `/me/ui-preferences` | Cualquier rol autenticado | theme/darkMode/itDashboardLayout del usuario |
| PUT | `/me/ui-preferences` | Cualquier rol autenticado | Upsert con Zod (theme ∈ {quiet-pro, workshop, dystopia}) |

---

## 4. Protocolo del agente de monitoreo

Agente en **Go** corriendo como servicio de Windows (flota Windows 10/11). Conexión **saliente** del agente hacia el backend en la LAN (no se abren puertos entrantes en los equipos ni se expone el backend a Internet).

### 4.1 Enrolamiento

1. IT genera un token de un solo uso desde `/it/enroll` (`POST /agents/enroll-tokens`). El backend guarda solo el `sha256` (`tokenHash`) con vencimiento corto (default 7 días); el plano se muestra una única vez.
2. El instalador (GPO/MSI o manual) invoca `POST /agents/enroll` (endpoint público con rate limit, sin JWT):

```json
// Request
{
  "token": "<token de un solo uso>",
  "machineId": "<MachineGuid de HKLM Cryptography>",
  "hostname": "PC-CONTA-03",
  "osName": "Windows 11 Pro",
  "osVersion": "10.0.26100",
  "agentVersion": "1.0.0"
}
// Response (agentSecret visible UNA sola vez; en DB solo su sha256)
{
  "deviceId": "cku...",
  "agentSecret": "<random >= 32 bytes>",
  "wsUrl": "wss://<backend>/agents/ws",
  "heartbeatSec": 60,
  "inventoryIntervalSec": 86400,
  "metricSampleSec": 300
}
```

3. El backend hace **upsert por `machineId`** (re-enrolar no duplica el equipo), guarda `secretHash` y marca el token como usado (`usedAt`, `usedByDeviceId`).

### 4.2 Conexión WebSocket (hub)

- Handshake: `GET /agents/ws` con headers `x-device-id` + `x-agent-secret`; el backend valida contra `secretHash` y `AgentDevice.isActive`. Revocación inmediata: `isActive=false` → el WS se rechaza/cierra.
- El hub se implementa con la lib `ws` en modo `noServer`, enganchado al evento `upgrade` del `http.Server` (hoy `index.ts` usa `app.listen`; hay que exponer el server). Cambio de bootstrap detrás de **feature flag**.

### 4.3 Mensajes (agente → servidor)

```json
// Heartbeat (cada heartbeatSec): sobreescribe el "último valor conocido"
// en AgentDevice; NO genera filas.
{ "type": "heartbeat", "ts": "2026-07-10T12:00:00Z",
  "data": { "loggedInUser": "jperez", "primaryIp": "192.168.1.42",
    "primaryMac": "AA:BB:CC:DD:EE:FF", "uptimeSec": 86400,
    "cpuPct": 12.5, "ramUsedMb": 6144, "ramTotalMb": 16384,
    "batteryPct": 87, "batteryCharging": true,
    "vncRunning": true, "sshRunning": true } }

// Muestra de métrica (cada metricSampleSec = 5 min, downsampleada):
// única serie que genera filas (AgentMetricSample), podada por cron.
{ "type": "metric", "ts": "...",
  "data": { "cpuPct": 12.5, "ramUsedMb": 6144, "diskUsedPct": 71.2, "batteryPct": 87 } }

// Inventario completo (cada inventoryIntervalSec o a demanda):
// se persiste como AgentInventorySnapshot (payload JSON).
{ "type": "inventory", "ts": "...",
  "payload": { "os": {...}, "disks": [...], "nics": [...], "software": [...] } }
```

### 4.4 Mensajes (servidor → agente)

```json
{ "type": "request_inventory" }   // disparado por POST /agents/devices/:id/request-inventory
{ "type": "revoked" }             // el agente debe detenerse; el server cierra el WS
```

### 4.5 Estado online/offline y retención

- `connState` se deriva de `lastSeenAt`: **OFFLINE si `lastSeenAt > 3 × heartbeatSec`** (umbral documentado; un reinicio del backend marca todo OFFLINE hasta el próximo heartbeat — aceptable).
- Cron de retención (script `tsx` estilo `src/scripts/*.ts`): borra `AgentMetricSample` con `sampledAt < now - 14d` y conserva los últimos 30 `AgentInventorySnapshot` por equipo. **No es opcional**: sin él, Postgres se infla.
- Opcional (desactivado por defecto): Notification in-app a AGENT/ADMIN cuando un equipo pasa a OFFLINE más de X minutos.

---

## 5. Acceso remoto (SSH web y VNC)

### 5.1 Arquitectura

```
Navegador (panel IT, AGENT/ADMIN)
   │  wss:// mismo origen — token efímero de un solo uso
   │  (por subprotocolo o primer mensaje del WS; PROHIBIDO en query string)
   ▼
Backend (http.Server 'upgrade' + validación Origin + JWT/rol)
   ├── Pasarela SSH: lib ssh2 → OpenSSH Server del equipo destino (puerto 22)
   └── Proxy VNC:    TCP → WS  → UltraVNC del equipo destino (puerto 5900)
```

- El navegador **nunca** recibe credenciales de dispositivos ni se conecta directo al equipo destino.
- Cada inicio/cierre de sesión escribe `RemoteSession` (operativo, con bytes/duración/estado) **y** `AuditLog` (registro de seguridad inmutable: actor, IP de origen, equipo destino, tipo, inicio/fin).
- El upgrade del WS del panel valida `Origin`, exige JWT válido + rol antes de aceptar y cierra la sesión si el token expira.

### 5.2 SSH web

- Front: `@xterm/xterm` + `addon-fit` + `addon-attach` conectado por WS a la pasarela.
- Autenticación contra el equipo: **clave pública de una cuenta de servicio de IT**, desplegada por GPO en `administrators_authorized_keys` de cada Windows (OpenSSH Server). La clave privada vive solo en el backend (env/secret store). No se guardan credenciales SSH por dispositivo en la DB.
- El botón "Terminal SSH" se habilita según el flag `sshRunning` reportado por el agente.

### 5.3 VNC — fases

| Fase | Mecanismo | Detalle |
|---|---|---|
| **Fase 1** | Visor local | `GET /agents/devices/:id/vnc-launch` genera un archivo `.vnc` efímero (host/puerto, sin password) para abrir el visor instalado en la PC del operador. Registra RemoteSession + AuditLog |
| **Fase 2** | noVNC en el navegador | `GET /agents/devices/:id/vnc` — proxy TCP→WS hacia el 5900 (UltraVNC); front con `@novnc/novnc` (import dinámico) |

- Password de UltraVNC: cifrada en `DeviceVncCredential` con `crypto.service.ts` (AES-256-GCM, clave `IT_SECRETS_KEY`, `keyVersion` para rotación). La API nunca la devuelve.
- Riesgo conocido: UltraVNC usa autenticación DES débil y sin TLS nativo → mantener dentro de la LAN, cifrar el tramo navegador↔backend (wss) y evaluar refuerzo (MSLogonII / plugin de cifrado) o tunelizar por SSH.

---

## 6. Frontend — sección IT, navegación y theme

### 6.1 Árbol de rutas canónico `/it/*` (fix del revisor: reemplaza las 4 convenciones previas)

Protección **única** en `src/App.tsx`: un route padre con `RoleProtectedRoute` + `Outlet` (se eliminan los wrappers por página de los otros diseños). Todas las páginas lazy, archivos en `src/pages/it/*` con prefijo `It*`, componentes en `src/components/it/*`, textos en español rioplatense.

```tsx
<Route
  path="it"
  element={
    <RoleProtectedRoute allowedRoles={["ADMIN", "AGENT"]}>
      <Outlet />
    </RoleProtectedRoute>
  }
>
  <Route index element={<ItDashboardPage />} />
  <Route path="inventory" element={<ItInventoryPage />} />
  <Route path="inventory/new" element={<ItAssetEditorPage />} />
  <Route path="inventory/:id" element={<ItAssetDetailPage />} />
  <Route path="inventory/:id/edit" element={<ItAssetEditorPage />} />
  <Route path="maintenance" element={<ItMaintenancePage />} />
  <Route path="purchases" element={<ItPurchasesPage />} />
  <Route path="purchases/new" element={<ItPurchaseEditorPage />} />
  <Route path="purchases/:id" element={<ItPurchaseDetailPage />} />
  <Route path="purchases/:id/edit" element={<ItPurchaseEditorPage />} />
  <Route path="purchases/suppliers/:id" element={<ItSupplierDetailPage />} />
  <Route path="staff" element={<ItStaffPage />} />
  <Route path="staff/people/:id" element={<ItPersonDetailPage />} />
  <Route path="staff/lines/:id" element={<ItPhoneLineDetailPage />} />
  <Route path="network" element={<ItNetworkPage />} />
  <Route path="live" element={<ItLiveDevicesPage />} />
  <Route path="live/:deviceId" element={<ItLiveDeviceDetailPage />} />
  <Route path="remote" element={<ItRemoteSessionsPage />} />
  <Route path="remote/:sessionId" element={<ItRemoteSessionPage />} />
  <Route path="enroll" element={<ItEnrollPage />} />
</Route>
```

**Páginas** (contenido consolidado de los 5 diseños):

- `/it` — **ItDashboardPage**: único dashboard IT (se descarta la fila de cards en el DashboardPage existente). Estética terminal: reloj UTC-3, línea de estado tipo prompt ("> TODOS LOS SERVICIOS NOMINALES" / "> N ALERTAS ACTIVAS"). 6 widgets (react-query, `refetchInterval: 30000`, datos de `GET /it-dashboard/summary`): equipos en línea, alertas de hardware (disco >90%, batería <60%), mantenimientos (vencidos + próximos 7 días), garantías ≤90 días, costo mensual de líneas (total + sparkline recharts 6 meses + top 5), tickets IT abiertos. Widgets como componentes en `src/components/it/widgets/*`.
- `/it/inventory` — tabla de equipos con búsqueda por código/serie/marca, filtros por tipo/estado/sector/persona asignada, chips de estado, badge "Garantía por vencer". Editor con specs dinámicas por tipo (IMEI para celulares, MAC para red) y aviso fijo "No cargues contraseñas acá". Detalle con timeline de asignaciones, mantenimientos, tickets vinculados, compra de origen y línea que porta (si es celular); acciones Asignar (buscador de Person + sector), Devolver a depósito, Dar de baja (ADMIN), Registrar mantenimiento.
- `/it/maintenance` — pestañas "Próximos" (preventivos por fecha) e "Historial"; alta/edición por modal con equipo, tipo, fecha, técnico o proveedor, costo con moneda y repuestos dinámicos.
- `/it/purchases` — tabs **Órdenes | Proveedores** (una sola página). Órdenes: pipeline Solicitada → Autorizada → Pedida → Recibida, badge de pendientes de autorizar para ADMIN. Editor con proveedor (alta rápida), moneda + cotización si USD, items dinámicos con checkbox "genera equipo en inventario", justificación obligatoria. Detalle con adjuntos drag & drop y wizard de recepción (pide series por item y muestra los assetTag generados). Proveedores: ABM por modal + detalle con historial.
- `/it/staff` — tabs **Personal | Líneas**. Personal: tabla con legajo, puesto, sector (chip), estado, badge "Con cuenta", cantidad de líneas; ficha con vincular/desvincular cuenta (ADMIN) y leyenda de privacidad en notas. Líneas: cards de stats (costo total con `Intl.NumberFormat es-AR`), tabla con titular y equipo; detalle con timeline, acciones Asignar / Liberar / SIM swap / Ver PUK (ADMIN, con confirmación porque queda auditado).
- `/it/network` — tab-switcher **Dispositivos | Topología**. Dispositivos: tabla con icono por tipo, IP con botón copiar, chips de VLANs, "Abrir administración" (`rel="noopener noreferrer"`), campo "Referencia de credencial" con hint. Topología: canvas React Flow con nodos custom por tipo, edges con etiqueta de puertos y estilo por tipo de enlace, guardado EXPLÍCITO ("Guardar layout" + "Cambios sin guardar" + Ctrl+S; 409 → "Otro usuario guardó esta vista, recargá"), modal de alta de enlace al conectar handles, panel lateral de detalle, MiniMap/Controls/Background theme-aware.
- `/it/live` y `/it/live/:deviceId` — grilla de equipos con heartbeat (online/offline, usuario logueado, IP, CPU/RAM, batería, flags SSH/VNC) y detalle con tarjetas de inventario + gráficos recharts + botones "Terminal SSH" / "VNC" / "Pedir inventario ahora".
- `/it/remote` y `/it/remote/:sessionId` — historial/auditoría de sesiones y sesión activa (terminal `@xterm/xterm` o visor `@novnc/novnc` según tipo, imports dinámicos).
- `/it/enroll` — generación de tokens de enrolamiento (copiable una sola vez) + instrucciones de instalación + lista de tokens activos/usados/vencidos.

**Integraciones fuera de `/it`** (se conservan):
- **TicketDetailPage**: para AGENT/ADMIN, selector "Equipo vinculado" (autocomplete por código/serie/persona) que setea `ticket.assetId`, y botón "Registrar mantenimiento" que precarga assetId + ticketId.
- **CommandPalette**: registrar las páginas IT (solo si rol AGENT/ADMIN).

### 6.2 Navegación (una sola modificación a `useNavItems()` en `_shared.tsx`)

Extender `NavItem` con `section?: "general" | "it"`. Grupo con etiqueta **"Gestión IT"** (elegida por el revisor); en `QuietProLayout` y `WorkshopLayout`, antes del primer ítem `section === "it"` se renderiza un separador con esa etiqueta (estilo `text-xs text-muted-foreground`). Los ítems de nav propuestos por los otros diseños se eliminan. Ítems (todos `showFor: ["AGENT", "ADMIN"]`, `section: "it"`):

| Ruta | Label | Icono (lucide) |
|---|---|---|
| `/it` | Panel IT | Activity |
| `/it/inventory` | Inventario | HardDrive |
| `/it/maintenance` | Mantenimientos | Wrench |
| `/it/purchases` | Compras y proveedores | ShoppingCart |
| `/it/staff` | Personal y líneas | Smartphone |
| `/it/network` | Red y topología | Network |
| `/it/live` | Equipos en vivo | Radar |
| `/it/remote` | Sesiones remotas | TerminalSquare |

Los siblings de `NavLink` deben incluir las rutas `/it/*` para que el matching por prefijo no marque dos ítems activos.

### 6.3 Theme "Dystopia" (tokens completos)

Tercer theme en `src/index.css` (dentro del `@layer base` existente). Claro = "papel de terminal" greenbar; oscuro = CRT fósforo. Todos los pares texto/fondo cumplen WCAG AA ≥ 4.5:1.

```css
/* ---------------------------------------------------------
   Dystopia — terminal CRT. Fósforo verde + ámbar de alerta.
   Claro = papel de terminal (greenbar). Oscuro = CRT clásico.
   --------------------------------------------------------- */
[data-theme="dystopia"] {
  --background: 100 12% 93%;
  --foreground: 140 45% 13%;

  --card: 100 15% 97%;
  --card-foreground: 140 45% 13%;

  --popover: 100 15% 97%;
  --popover-foreground: 140 45% 13%;

  --primary: 150 85% 22%;            /* verde consola oscuro */
  --primary-foreground: 100 15% 97%;

  --secondary: 110 10% 88%;
  --secondary-foreground: 140 40% 16%;

  --muted: 110 10% 88%;
  --muted-foreground: 140 14% 34%;

  --accent: 45 90% 88%;              /* ámbar pálido */
  --accent-foreground: 40 90% 22%;

  --destructive: 0 75% 42%;
  --destructive-foreground: 0 0% 100%;

  --border: 120 10% 76%;
  --input: 120 10% 76%;
  --ring: 150 85% 26%;

  --radius: 0.125rem;                /* esquinas casi rectas */

  --glow: 150 85% 26%;
  --glow-alpha: 0;                   /* sin glow en claro */

  --status-open: 190 90% 27%;
  --status-progress: 40 95% 32%;
  --status-resolved: 150 85% 24%;
  --status-closed: 140 8% 40%;
  --priority-low: 150 85% 24%;
  --priority-medium: 40 95% 32%;
  --priority-high: 28 90% 34%;
  --priority-urgent: 0 75% 42%;
}

[data-theme="dystopia"].dark {
  --background: 120 10% 4%;          /* negro CRT */
  --foreground: 135 65% 72%;         /* fósforo verde legible (~8.5:1) */

  --card: 120 10% 7%;
  --card-foreground: 135 65% 72%;

  --popover: 120 12% 6%;
  --popover-foreground: 135 65% 72%;

  --primary: 135 95% 55%;            /* fósforo puro para CTAs */
  --primary-foreground: 120 10% 4%;

  --secondary: 120 10% 12%;
  --secondary-foreground: 135 50% 75%;

  --muted: 120 10% 11%;
  --muted-foreground: 135 20% 58%;   /* ~5.3:1 sobre fondo */

  --accent: 135 40% 15%;             /* hover verde profundo */
  --accent-foreground: 135 80% 78%;

  --destructive: 0 90% 60%;
  --destructive-foreground: 120 10% 4%;

  --border: 135 30% 20%;
  --input: 135 30% 20%;
  --ring: 135 95% 55%;

  --glow: 135 95% 55%;
  --glow-alpha: 0.35;

  --status-open: 180 85% 55%;        /* cian terminal */
  --status-progress: 45 95% 58%;     /* ámbar */
  --status-resolved: 135 85% 60%;
  --status-closed: 135 8% 55%;
  --priority-low: 135 85% 60%;
  --priority-medium: 45 95% 58%;
  --priority-high: 28 95% 60%;
  --priority-urgent: 0 95% 64%;
}
```

Y en el segundo `@layer base` (junto a la tipografía por theme):

```css
/* Dystopia → IBM Plex Mono (self-hosted vía @fontsource). */
[data-theme="dystopia"] body {
  font-family: "IBM Plex Mono", "JetBrains Mono", ui-monospace,
    SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.01em;
}
[data-theme="dystopia"] h1,
[data-theme="dystopia"] h2 {
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
/* Glow SOLO en titulares (no en texto de lectura, por legibilidad). */
[data-theme="dystopia"].dark :is(h1, h2) {
  text-shadow: 0 0 8px hsl(var(--glow) / var(--glow-alpha));
}
/* Selección invertida estilo terminal. */
[data-theme="dystopia"].dark ::selection {
  background: hsl(135 95% 55% / 0.9);
  color: hsl(120 10% 4%);
}
/* Scanlines: overlay estático fijo, alpha bajísima, no bloquea clicks.
   Se apaga agregando la clase no-crt-fx en <html>. */
html[data-theme="dystopia"].dark:not(.no-crt-fx) body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  background: repeating-linear-gradient(
    to bottom,
    hsl(0 0% 0% / 0.14) 0 1px,
    transparent 1px 3px
  );
}
```

**`src/contexts/ThemeContext.tsx`**: `type ThemeName = "quiet-pro" | "workshop" | "dystopia"`; validación de `localStorage` contra la lista; carga lazy de la fuente solo si se elige el theme:

```ts
if (theme === "dystopia") {
  import("@fontsource/ibm-plex-mono/400.css");
  import("@fontsource/ibm-plex-mono/500.css");
  import("@fontsource/ibm-plex-mono/600.css");
}
```

**`src/components/ThemeSwitcher.tsx`** — entrada nueva:

```ts
{
  id: "dystopia",
  label: "Distópico",
  description: "Terminal CRT. Fósforo verde sobre negro.",
  swatches: ["hsl(135 95% 55%)", "hsl(45 95% 58%)", "hsl(120 10% 4%)"],
},
```

**`src/components/Layout.tsx`**: SIN cambios — dystopia cae en `QuietProLayout` por el ternario actual; los tokens hacen todo el trabajo visual (decisión deliberada: no crear un tercer layout).

### 6.4 Librerías nuevas y code-splitting

| Librería | Uso | Chunk |
|---|---|---|
| `@xyflow/react` ^12 | Topología de red | `vendor-flow` |
| `@xterm/xterm` ^5 + `@xterm/addon-fit` + `@xterm/addon-attach` | Terminal SSH (el paquete viejo `xterm` está deprecado) | `vendor-term` |
| `@novnc/novnc` ^1.5 | Visor VNC (Fase 2), import dinámico `await import("@novnc/novnc/lib/rfb")` | `vendor-vnc` |
| `@fontsource/ibm-plex-mono` | Tipografía self-hosted (sin CDN) | lazy con el theme |

Métricas del agente: **recharts ya existe** y ya tiene chunk propio — no se suma otra lib de gráficos. `manualChunks` en `vite.config.ts`:

```ts
manualChunks: {
  "vendor-charts": ["recharts"],
  "vendor-markdown": ["react-markdown", "remark-gfm"],
  "vendor-dnd": ["@dnd-kit/core"],
  "vendor-flow": ["@xyflow/react"],
  "vendor-term": ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-attach"],
  "vendor-vnc": ["@novnc/novnc"],
},
```

Reglas: las libs nuevas se importan **solo** desde páginas lazy bajo `/it` (consumidores puros, no rompen el orden de inicialización); los CSS de `@xyflow/react` y `@xterm/xterm` se importan dentro de la página lazy correspondiente, no en `index.css`.

---

## 7. Seguridad y datos sensibles (consolidado)

**Autorización**
- Los módulos IT completos van con `authMiddleware + requireRole([UserRole.AGENT, UserRole.ADMIN])` a nivel router; los USER no tienen NINGÚN acceso (precios, proveedores, series, asignaciones, IPs, topología y costos son datos sensibles del negocio y de las personas).
- Acciones destructivas o sensibles restringidas a ADMIN **a nivel de ruta, no solo de UI**: autorizar compras, dar de baja equipos/dispositivos/sitios/personas/líneas, borrar registros, editar assetTag, ver/setear PUK, setear password VNC, revocar tokens y agentes.
- El gating por rol del front (`RoleProtectedRoute`, `showFor`) es solo UX: la autoridad real es el backend.
- `authorizedById` y todo campo de actor se setea siempre desde `req.user.id` del token, jamás desde el body.

**Política única de secretos (fix del revisor)**
- **Por defecto**: los secretos NO se guardan en esta base. Campo unificado `secretsRef` (Asset y NetworkDevice) con una referencia al gestor de contraseñas del equipo (Vaultwarden/Bitwarden/1Password) — nunca la credencial, ni cifrada, ni en `notes`/`specs`. La UI muestra el aviso.
- **Cuando el negocio exige persistir** (PUK de SIM, password de UltraVNC): helper común `src/services/crypto.service.ts` con AES-256-GCM, **una sola clave maestra** `IT_SECRETS_KEY` (32 bytes, en env, fuera del repo y de la DB), IV/nonce aleatorio por registro, tag de autenticación y `keyVersion` para rotación. Formato único `cipherText/iv/authTag/keyVersion`. Las claves `PHONE_SECRETS_KEY` y `VNC_MASTER_KEY` de los diseños originales desaparecen.
- Revelado de secretos: solo ADMIN, por endpoint dedicado, siempre con `AuditLog` (ej. `puk_viewed`). Excluidos de todos los selects de list/detail.
- La validación Zod de `Asset.specs` rechaza claves tipo `password/pass/pin/clave/token` y también `linea/phoneNumber/iccid` (los datos de línea viven solo en `PhoneLine`).

**Autenticación del agente**
- Dos etapas: token de enrolamiento de un solo uso (hasheado sha256, expiración corta, rate limit con `express-rate-limit`) → `agentSecret` aleatorio ≥32 bytes guardado solo hasheado. El agente nunca recibe JWT de usuario ni puede tocar endpoints de negocio. Revocación inmediata con `isActive=false`.

**Acceso remoto**
- El navegador nunca recibe credenciales de dispositivos; token efímero de un solo uso por subprotocolo o primer mensaje del WS (prohibido en query string); validación de `Origin` y JWT + rol antes del upgrade; wss siempre.
- SSH sin passwords por equipo (clave pública de cuenta de servicio por GPO; privada solo en backend).
- Toda sesión remota queda en `RemoteSession` + `AuditLog` (quién, desde qué IP, a qué equipo, cuándo, cuánto duró).

**Datos personales (Ley 25.326) y minimización**
- `Person` guarda SOLO datos laborales: deliberadamente NO hay DNI, CUIL, domicilio, contacto personal, fecha de nacimiento ni datos de salud. Leyenda visible en la UI sobre el campo notas.
- Derecho de supresión: hard delete de `Person` cascadea su historial de líneas; el flujo normal es baja lógica que conserva historial.
- No loguear datos sensibles: el logger no recibe números de línea completos, ICCID, PUK, IPs ni MACs — solo ids cuid. El meta de AuditLog usa diffs de campos e IDs (últimos 4 dígitos del número si hace falta mostrar algo), nunca dumps de objetos.

**Otros**
- `AuditLog` genérico en toda mutación de todos los módulos (entity/entityId/action/actorId/meta con diff).
- Adjuntos por `fileValidation.service` (whitelist pdf/jpg/png, límite de tamaño) y servidos solo autenticados vía `filesServingRouter`; nunca URLs públicas.
- `adminUrl` validado http/https únicamente (bloquea `javascript:`/`data:`); abierto con `target=_blank` + `rel="noopener noreferrer"`.
- Zod estricto en todo: `z.string().ip()`, MAC con regex y normalización, E.164, ICCID 19-20 dígitos, montos Decimal positivos, `cuid()` en FKs, enums cerrados, `pageSize <= 100`, layout ≤ 500 nodos.
- Nada sensible en `localStorage` (solo `ui:theme` / `ui:dark`); libs y fuentes self-hosteadas por npm, cero CDNs, compatible con CSP estricta.
- El editor de topología es documentación pasiva: nunca ejecuta nada contra los dispositivos (sin SNMP/SSH desde el navegador).
- Al cargar inventario histórico desde planillas, revisar que no viajen contraseñas ni datos de clientes en campos libres (`notes`/`specs`).

---

## 8. Riesgos (consolidado)

**Base de datos / deploy**
1. `prisma db push` en producción activa: el diseño completo es aditivo, pero los `@unique` nuevos (serialNumber, phoneNumber, simIccid, employeeNumber, workEmail, Person.userId) rechazarán cargas históricas con duplicados → limpieza previa de planillas + validación en service para devolver errores claros (no P2002 crudo).
2. El merge del schema es UNO solo (fix del revisor): elimina el problema de orden de deploy entre módulos (FKs a Asset), pero el push único debe ensayarse en staging.
3. Consistencia denormalizado vs historial: `Asset.status/assignedPersonId` y `PhoneLine.holderId/status` deben moverse SIEMPRE junto con su assignment dentro de `$transaction`; si se saltea, el inventario miente.
4. Generación del assetTag correlativo: colisión entre dos agentes concurrentes → transacción serializable o tabla de secuencia por prefijo + reintento ante unique violation.
5. `AgentMetricSample` crece con la flota: el downsampling (1/5 min) y el cron de purga (14 días) son parte del diseño, no opcionales.
6. Cascadas: hard delete de Asset arrastraría mantenimientos (por eso la API solo hace soft delete); borrar un NetworkDevice elimina enlaces (mitigado con soft delete + snapshot en AuditLog.meta).

**Backend**
7. El hub WS exige exponer el `http.Server` y manejar `upgrade` (hoy `app.listen` directo): cambio de bootstrap acotado pero toca el arranque de un sistema en producción → feature flag y despliegue cuidadoso.
8. Prisma `Decimal` serializa como string en JSON: el front debe parsear y formatear con un helper único de moneda (`Intl.NumberFormat es-AR`); nunca aritmética float con montos.
9. Doble moneda ARS/USD sin cotización histórica obligatoria: los totales agregados deben mostrarse por moneda separada; `exchangeRate` es solo referencia.
10. Flujo de compra vs compras históricas: el service permite alta directa en RECEIVED sin romper las transiciones normales.
11. Unicidad de IP validada en service (no en DB) para permitir reusar IPs de equipos dados de baja: carrera teórica aceptada por volumen bajo.

**Acceso remoto / agente**
12. VNC: UltraVNC con auth DES débil y sin TLS → LAN only, wss en el tramo navegador↔backend, refuerzo (MSLogonII/plugin) o túnel SSH; Fase 2 recién cuando Fase 1 esté auditada.
13. La password VNC cifrada es un activo sensible: si se filtra `IT_SECRETS_KEY` se descifra todo → control de acceso al env y rotación con `keyVersion`.
14. Distribución del agente y de la clave SSH dependen de GPO/AD; sin GPO, instalación manual/MSI con mayor costo operativo.
15. Detección offline basada en `lastSeenAt`: un backend reiniciado marca todo OFFLINE hasta el próximo heartbeat (umbral 3× documentado).

**Frontend**
16. Bundle: noVNC (~200KB+) y @xyflow/react son pesados → chunks propios importados SOLO desde páginas lazy bajo `/it`; un import eager infla la primera carga de todos los usuarios.
17. Paquete `xterm` deprecado: usar solo los scoped `@xterm/*`; mezclar ambos rompe tipos y duplica código.
18. Legibilidad del theme CRT: glow solo en h1/h2, scanlines con escape hatch (`no-crt-fx`), contraste AA verificado; conviene una pasada visual sobre badges de status en ambos modos. El modo claro "papel de terminal" es una decisión estética a revisar si el equipo esperaba "siempre negro".
19. Concurrencia del editor de topología: last-write-wins mitigado con control optimista por `updatedAt` (409 + recarga), no con locking real.
20. React Flow con vistas >200 nodos: las vistas naturales son por sitio; la global debería incluir solo equipos de borde.
21. recharts con polling 30s alcanza; streaming subsegundo exigiría una lib canvas-based (no ahora).

**Operación / datos**
22. Topología "de papel" (sin discovery SNMP/LLDP): vale lo que valga la disciplina de carga; considerar a futuro import CSV o integración read-only.
23. Sin sincronización con RRHH el padrón se desactualiza (egresos con línea/equipo retenido): el filtro TERMINATED-con-línea-vigente ayuda a detectarlo; el flujo unificado de offboarding por Person (equipos + líneas en una sola consulta) lo mitiga.
24. Campos `notes` de texto libre: riesgo de volcado de datos personales pese a la leyenda → revisión periódica.
25. Números reciclados por la operadora: `phoneNumber @unique` → se reactiva el registro CANCELLED (documentado en la UI).
26. Adjuntos de facturas acumulan storage: monitorear tamaño y definir límite por archivo.

---

## 9. Plan de implementación (milestones)

| Milestone | Alcance | Repo(s) |
|---|---|---|
| **M1 — Schema unificado + base de seguridad** | Edición única de `prisma/schema.prisma` (sección 2 completa, incluidas las adiciones a User/Department/Ticket), **un solo** `prisma db push` (ensayado antes en staging); `src/services/crypto.service.ts` (AES-256-GCM, `IT_SECRETS_KEY`); esqueleto de routers montados en `routes/index.ts` con `requireRole`; validaciones Zod base | back |
| **M2 — Base front IT + theme** | Route padre `/it` con `RoleProtectedRoute` + `Outlet`; grupo "Gestión IT" en `useNavItems()`; theme Dystopia (tokens + ThemeContext + ThemeSwitcher); `UserUiPreference` + endpoints `/me/ui-preferences`; deps nuevas + `manualChunks` | front (+ back mínimo) |
| **M3 — Personal y líneas** | `/people` y `/phone-lines` completos (services transaccionales de asignación, PUK cifrado, stats); front `/it/staff` (tabs Personal \| Líneas + detalles). El padrón de Person habilita la tenencia de M4 | back + front |
| **M4 — Inventario, mantenimientos, compras y proveedores** | `/assets`, `/maintenances`, `/suppliers`, `/purchases` (asignación por Person, flujo de compra con autorización ADMIN, recepción → alta de Assets, adjuntos); front `/it/inventory`, `/it/maintenance`, `/it/purchases`; integración TicketDetailPage (`ticket.assetId` + botón "Registrar mantenimiento"); carga inicial del inventario histórico (con limpieza de duplicados) | back + front |
| **M5 — Red y topología** | `/network` completo (sitios, dispositivos, enlaces, vistas con layout persistido y control optimista); front `/it/network` con `@xyflow/react` (chunk lazy); regla de doble capa Asset↔NetworkDevice en service y drawer | back + front |
| **M6 — Agente de monitoreo** | Exponer `http.Server` + hub WS (`ws`, `noServer`, feature flag); enrolamiento por token de un solo uso; heartbeat/inventario/métricas + cron de retención; front `/it/live`, `/it/live/:deviceId`, `/it/enroll`; **agente Go MVP** (servicio Windows: enroll, heartbeat, inventario, métricas) | back + front + agente (repo nuevo) |
| **M7 — Panel IT** | `GET /it-dashboard/summary` (agregador que reutiliza los services de stats de M3–M6); front `ItDashboardPage` con los 6 widgets; registro en CommandPalette | back + front |
| **M8 — Acceso remoto Fase 1** | Pasarela SSH (ssh2 + token efímero + Origin check), despliegue de clave pública por GPO; VNC por visor local (`/vnc-launch`); `RemoteSession` + AuditLog; front `/it/remote`, `/it/remote/:sessionId` (xterm), botones en `/it/live/:deviceId` | back + front + infra (GPO) |
| **M9 — Acceso remoto Fase 2** | Proxy TCP→WS al 5900 + noVNC en el navegador (import dinámico, chunk `vendor-vnc`); refuerzo de UltraVNC evaluado (MSLogonII / túnel SSH) | back + front |

Dependencias clave: M1 precede a todo; M3 antes que M4 (la asignación de equipos referencia Person); M6 antes que M7 (el dashboard consume datos del agente) y antes que M8/M9 (flags `sshRunning`/`vncRunning` y credencial VNC).

---

## 10. Preguntas de negocio abiertas (consolidado, deduplicado)

**Compras e inventario**
1. ¿La autorización de compras es solo del responsable de IT (ADMIN) o hay montos a partir de los cuales debe autorizar Gerencia/Administración (segundo aprobador)?
2. ¿Existe un formato previo de código interno en las etiquetas físicas que haya que respetar/importar, o se arranca con el formato nuevo por tipo (NB-0001, PC-0001)?
3. ¿Los empleados (rol USER) deberían ver una ficha "Mis equipos" con lo asignado (y quizás firmar la recepción), o el inventario queda 100% interno de IT?
4. ¿Contabilidad necesita datos patrimoniales al dar de baja (valor de amortización, acta firmada) o alcanza con motivo + fecha + quién autorizó?
5. ¿Los preventivos siguen un calendario fijo por tipo de equipo (auto-generable) o se programan a mano?
6. ¿Se necesita control de stock de insumos consumibles (toners, cables) o alcanza con items de compra sin inventariar?

**Personal y líneas**
7. ¿Se da de alta personal externo/contratistas sin legajo? (employeeNumber quedó opcional por las dudas)
8. ¿Quién mantiene el padrón de personal: IT a mano o RRHH provee un listado periódico para importar?
9. ¿IT necesita guardar PIN/PUK de las SIMs o los consultan en el portal de la operadora? (si no hace falta, se eliminan los campos cifrados y el endpoint de revelado)
10. ¿Existen líneas BYOD (personales con abono pagado por la empresa) que deban registrarse distinto de las corporativas?
11. ¿El costo mensual se actualiza a mano por línea o llega factura consolidada por operadora (a futuro: import mensual)?

**Red**
12. ¿Qué sitios físicos hay que documentar (solo sede central o también sucursales/depósitos)? Define las vistas por sitio y si la vista global WAN tiene sentido desde el día uno.
13. ¿Los enlaces WAN/Internet con datos de contrato del ISP (ancho de banda, número de servicio, soporte) se cargan como NetworkLink tipo WAN con notas, o los gestiona compras/contratos?
14. ¿Se quiere en fase 2 vincular tickets a dispositivos de red (campo opcional `networkDeviceId` en Ticket)?
15. ¿Confirmamos que solo ADMIN da de baja dispositivos y sitios (AGENT solo crea/edita)?

**Agente y acceso remoto**
16. ¿La retención propuesta (métricas 14 días, últimos 30 inventarios por equipo) alcanza o se necesita más histórico para auditoría/compliance?
17. ¿Se persiste la password de UltraVNC (cifrada, conexión con un click) o el operador la ingresa en cada conexión sin persistir nada?
18. SSH: ¿cuenta de servicio única con clave desplegada por GPO, o cada operador con su credencial de dominio (más trazabilidad, más fricción)?
19. ¿Confirmamos el alcance de Fase 1 (SSH web + VNC por visor local) dejando noVNC para Fase 2?
20. ¿Tokens de enrolamiento de un solo uso por equipo, o token de lote reutilizable con límite de N equipos para despliegue masivo por GPO?
21. ¿Qué define el "sector" de un equipo para los filtros: el Asset, el usuario logueado habitual o una asignación manual? (con la tenencia unificada en Person, la vía natural es Person→Department; confirmar)
22. ¿Se notifica (in-app/mail) cuando un equipo crítico queda offline y a quiénes?
23. ¿Hay infraestructura GPO/MSI (dominio AD) disponible, o hace falta también un instalador manual firmado?

**Frontend**
24. ¿El theme Distópico se ofrece a todos los usuarios o solo al equipo IT? (propuesta: a todos, es solo estética)
25. ¿Umbrales correctos?: garantías "por vencer" a 90 días, mantenimientos "próximos" a 7 días, alerta de disco al 90%, batería al 60%. (Nota: un diseño usaba 60 días para garantías y otro 90; el consolidado adopta 90 — confirmar)
26. ¿El costo mensual de líneas se muestra en ARS nominal o necesita normalización (USD / ajuste por inflación) para comparar meses?
27. ¿El Panel IT es la home por defecto para AGENT/ADMIN o convive con el dashboard actual? (propuesta: convive)
