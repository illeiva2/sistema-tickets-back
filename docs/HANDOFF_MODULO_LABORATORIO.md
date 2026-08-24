# Handoff: módulo de laboratorio (GlutenLab) en sistema-tickets

Resumen para la otra conversación de Code que trabaja sobre `sistema-tickets`.
Nada de esto es un plan: ya está mergeado en `main` y corriendo en producción.

## Qué se agregó

### 1. Permisos por módulo (`ModuleGrant`)

Sistema de habilitación de módulos por usuario, independiente del rol.

- Modelo `ModuleGrant` en `prisma/schema.prisma`.
- La unicidad de un grant activo se declara con un **índice parcial escrito a
  mano** en el `migration.sql` (`WHERE "revokedAt" IS NULL`), porque Prisma no
  sabe declarar índices parciales. Si regenerás la migración, ese índice se
  pierde.
- Revocar es `revokedAt`, nunca un DELETE: hace falta el rastro de quién tuvo
  acceso a qué y hasta cuándo.
- `src/middleware/requireModule.ts` — `requireModule("glutenlab")` protege rutas.
- `src/lib/modules.ts` tiene el registro de módulos conocidos.
- Admin: `/admin/modulos` en el front (`AdminModulesPage.tsx`).
- El front expone `ModulesContext` y `NavItem` acepta `requiresModule`, así un
  item del menú desaparece si el usuario no tiene el módulo.

### 2. Espejo de mediciones de laboratorio

Réplica de las mediciones que los dos Glutomatic y el NIR escriben al SQL Server
del molino, para que el panel se pueda abrir desde internet.

- `LabMeasurement` / `LabParameter` en formato largo (los parámetros del NIR
  varían por producto; una tabla ancha exigiría una migración por calibración).
- `LabFeed` — una fila por origen, con cursor y estado del enlace.
- `ServiceClient` — credenciales de agentes, no de personas. Se guarda solo el
  hash del secreto.
- Rutas en `/api/glutenlab/*` (`src/routes/lab.routes.ts`).
- El agente que corre en planta (`GlutenLab.CloudPusher`) vive en el repo
  **GlutenLab**, no acá.

## Convenciones que te van a morder si no las sabés

**El `baseURL` de axios en el front es la raíz del servicio, no `/api`.** Toda
llamada escribe el prefijo a mano: `api.get("/api/departments")`. Yo perdí un
rato con seis llamadas que devolvían 404 por inferir esto en lugar de mirar una
llamada vecina.

**`tsconfig` no tiene `strict` ni `strictNullChecks`.** Eso colapsa la
inferencia de Zod a "todo opcional", así que los handlers no pueden tipar el
body desde el schema. En `lab.controller.ts` se tipa contra los contratos del
servicio con `as unknown as`, sabiendo que `validate()` ya corrió.

**`TicketsService.createTicket(data: any, userId)`.** El parámetro es `any`, así
que un valor de enum mal escrito compila y explota en runtime. Pasó: mandé
`category: "Infraestructura"`, que no existe en `TicketCategory`
(`SOFTWARE | HARDWARE | RED | ERP | OTRO`), y falló cada creación de ticket.
Si llamás a esto, **nombrá los enums de Prisma** (`TicketCategory.SOFTWARE`) en
lugar de strings sueltos, así el compilador te cubre igual.

**Render corre en UTC, la planta está en UTC-3.** Cualquier `getHours()` o
`getDay()` sobre lógica de horario laboral está corrido tres horas. Ver
`isSourceQuiet` en `lab.service.ts`, que evalúa explícitamente en
`America/Argentina/Cordoba`.

**`/api/glutenlab/ingest` está exento del limitador global** de 300 req/15 min.
Ese limitador se llavea por IP y toda la oficina sale por la misma IP pública:
un backfill del agente vaciaba el balde y dejaba al staff con 429. Mismo
razonamiento que ya estaba escrito para el flujo de Google OAuth.

## Detección de fallas: por qué está diseñada así

El antecedente concreto es que ya hubo otro mirror en la empresa que se cayó y
dejó los dashboards mostrando datos viejos sin avisarle a nadie. Todo este
aparato existe para que no se repita.

- El heartbeat se manda en **cada** corrida del agente, haya o no mediciones
  nuevas. Es lo único que separa "el enlace se cortó" de "hoy no se midió nada".
- El estado del feed se **deriva por edad** en cada lectura y nunca se persiste
  como adjetivo, así que no puede quedar un `OK` viejo pegado en la base.
- `ingestedAt` (reloj del servidor) va separado de `analyzedAt` (reloj del
  instrumento). La frescura se calcula siempre contra el primero: un equipo con
  la hora corrida no puede fabricar un falso "al día".
- El cursor tiene **un solo dueño**: `advanceCursor`, que solo lo mueve si el
  lote entró entero. El heartbeat NO lo escribe — cuando lo escribía, anulaba
  esa guarda segundos después de aplicarla.
- El reconcile compara por día **conteo y suma de valores**. El conteo va con
  `COUNT(DISTINCT)`: con el `LEFT JOIN` a los parámetros, un `COUNT(*)` cuenta
  filas unidas y marca todos los días como distintos, siempre.
- El watchdog abre **un** ticket por incidente y re-escala cada 6 h. El freno
  depende solo de `alertLastNotifiedAt`, nunca de que el ticket exista: cuando
  dependía del ticket, una falla al crearlo se convirtió en push a todos los
  admins cada 5 minutos.
- Hay un dead-man switch externo (`LAB_HEALTHCHECK_URL`) pingueado **después**
  de commitear el heartbeat, así el ping afirma "el dato quedó en la base" y no
  "me llegó una request". Es la única capa que sobrevive a que se caiga Render.

## Estado y qué falta

Espejado y verificado contra los datos reales: 23.929 mediciones de Glutomatic
(desde dic-2022) y 4.943 del NIR, más ~125 mil filas de parámetros. El reconcile
da cero diferencias.

**No hay ninguna pantalla todavía.** Lo que falta es portar las cuatro vistas
del dashboard .NET a este backend. Cuando lo hagas: la agregación va **en SQL**,
no en memoria. El original agrega en memoria sobre un snapshot cacheado, y ahí
era correcto (SQL Server Express elegía planes inestables), pero contra Supabase
eso sería un error de egress y latencia.
