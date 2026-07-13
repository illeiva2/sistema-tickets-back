# Sistema de Tickets — Backend

API REST para el sistema interno de gestión de tickets de soporte.
Acompaña al frontend en
[`sistema-tickets-front`](https://github.com/illeiva2/sistema-tickets-front).

## Stack

- **Runtime:** Node.js ≥ 20
- **Lenguaje:** TypeScript 5
- **Framework:** Express 4
- **ORM:** Prisma 6 sobre PostgreSQL
- **Auth:** JWT (access 8h + refresh 7d) + Passport.js (Google OAuth)
- **Storage de archivos:** Cloudinary
- **Email:** Nodemailer (SMTP)
- **Logging:** Pino
- **Tests:** Vitest + Supertest + vitest-mock-extended

## Estructura

```
src/
├── app.ts              # createApp(): Express app sin listen (testable)
├── index.ts            # Entry point: createApp + listen + signal handlers
├── config/             # Config y conexiones (db, email, oauth, passport)
├── controllers/        # Handlers HTTP
├── services/           # Lógica de negocio
├── routes/             # Mapeo URL → controller
├── middleware/         # auth, validation, requestId, fileServing, etc.
├── lib/                # database, errors, logger, sla, cloudinary
├── validations/        # Schemas Zod
├── scripts/            # backfill-due-at, cleanup-seed, seed
└── types/              # Type augmentations (Express.User)

prisma/
└── schema.prisma       # Modelo de datos
tests/                  # Test suite (vitest)
```

## Setup local

### Requisitos

- Node 20+
- PostgreSQL local o cuenta de Neon
- Cuenta de Cloudinary (free tier alcanza)
- (Opcional) Credenciales SMTP para probar emails (Gmail con app password sirve)
- (Opcional) Google OAuth credentials para login con Google

### Variables de entorno

Crear `.env` en la raíz:

```bash
# Base de datos
DATABASE_URL="postgresql://user:pass@localhost:5432/empresa_tickets"

# JWT
JWT_SECRET="cambiar-en-produccion"
JWT_EXPIRES_IN="8h"
JWT_REFRESH_EXPIRES_IN="7d"

# Server
PORT=3001
NODE_ENV=development

# Cloudinary
CLOUDINARY_CLOUD_NAME="tu-cloud"
CLOUDINARY_API_KEY="..."
CLOUDINARY_API_SECRET="..."

# Email (opcional)
EMAIL_HOST="smtp.gmail.com"
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER="tu@gmail.com"
EMAIL_PASSWORD="app-password"
EMAIL_FROM="noreply@tu-dominio.com"

# URL pública del frontend (para el botón "Ver ticket" en emails)
FRONTEND_URL="http://localhost:5173"

# Google OAuth (opcional)
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GOOGLE_CALLBACK_URL="http://localhost:3001/api/auth/google/callback"
ALLOWED_EMAIL_DOMAINS="empresa.com"

# Logging
LOG_LEVEL=info
```

### Comandos

```bash
npm install              # Instalar dependencias
npm run db:generate      # Regenerar Prisma client
npm run db:migrate:dev   # Aplicar migraciones (dev)
npm run db:seed          # Cargar datos demo (admin, agentes, usuarios, tickets)
npm run dev              # Levantar API en watch mode (puerto 3001)
npm test                 # Correr suite completa
npm run test:watch       # Tests en modo watch
npm run build            # Compilar a dist/
npm start                # Correr producción desde dist/
```

### Scripts puntuales

```bash
# Backfill de dueAt para tickets viejos sin SLA seteado.
npm run script:backfill-due-at

# Limpieza pre-producción: borra usuarios USER y AGENT del seed +
# tickets, comentarios, audit logs y notificaciones asociadas.
# El admin del seed NO se toca.
npm run script:cleanup-seed
```

## Modelo de datos

Resumen de las entidades principales:

- **User** (`USER`/`AGENT`/`ADMIN`) — soft delete via `isActive` + `deletedAt`.
- **Ticket** — `status` (`OPEN`/`IN_PROGRESS`/`RESOLVED`/`CLOSED`),
  `priority` (`LOW`/`MEDIUM`/`HIGH`/`URGENT`), `category`
  (`SOFTWARE`/`HARDWARE`/`RED`/`ERP`/`OTRO`), `dueAt` calculado por
  prioridad.
- **Comment** — comentarios públicos y notas internas (prefijo
  `[INTERNA] ` en `message`).
- **Attachment** — archivos en Cloudinary.
- **Notification** + **NotificationPreferences** — in-app + email.
- **AuditLog** — historial de acciones.
- **FileCategory**, **FileTag**, **FileOrganization** — organización de
  archivos.

Schema completo en [`prisma/schema.prisma`](./prisma/schema.prisma).

## Endpoints principales

```
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me
GET    /api/auth/google           (OAuth)
GET    /api/auth/google/callback

GET    /api/tickets               (filtros: q, status, priority, category, ...)
GET    /api/tickets/:id
GET    /api/tickets/:id/audit
POST   /api/tickets
PATCH  /api/tickets/:id
PATCH  /api/tickets/:id/claim
POST   /api/tickets/:id/resolve
POST   /api/tickets/:id/reopen
POST   /api/tickets/:id/close
DELETE /api/tickets/:id           (ADMIN)
POST   /api/tickets/:id/comments
GET    /api/tickets/:id/comments

GET    /api/users                 (ADMIN, ?includeInactive=true)
GET    /api/users/agents
POST   /api/users                 (ADMIN)
PATCH  /api/users/:id
DELETE /api/users/:id             (ADMIN, soft delete)
POST   /api/users/:id/restore     (ADMIN)
POST   /api/users/:id/reset-password (ADMIN)
PATCH  /api/users/:id/password

POST   /api/attachments/:ticketId
DELETE /api/attachments/:id       (ADMIN)
GET    /api/files/:fileName
GET    /api/thumbnails/:fileName

GET    /api/dashboard?period=7d|30d|90d|year
GET    /api/notifications/user
PATCH  /api/notifications/:id/read
PATCH  /api/notifications/mark-all-read
GET    /api/notifications/preferences
PATCH  /api/notifications/preferences

GET    /api/file-organization/categories
POST   /api/file-organization/categories
PUT    /api/file-organization/categories/:id
DELETE /api/file-organization/categories/:id
GET    /api/file-organization/tags
POST   /api/file-organization/tags
GET    /api/file-organization/search?query=...
```

Todas las rutas (salvo `/login`, `/register`, `/refresh`, OAuth y health
check) requieren `Authorization: Bearer <token>`.

## Seguridad

- **Rate limiting** activo en producción:
  - `/api/auth/login`: 10 req/min por IP (anti brute force).
  - Resto: 300 req / 15 min por IP, con skip a `/health`,
    `/api/auth/me`, `/uploads/*`, `/thumbnails/*`.
- **Helmet** para headers HTTP seguros.
- **CORS** configurable por env (`FRONTEND_URL` y orígenes adicionales).
- **JWT secret** obligatorio en prod (validado en config).
- **bcrypt** con 12 rounds para password hashing.

## Tests

Suite con **60 tests** cubriendo flujos críticos:

- Auth (11): login OK/fail/cuenta desactivada/Google sin password,
  refresh OK/desactivada/inválido, GET /me.
- Tickets (21): create, list con filtros, getById con permisos, claim,
  resolve, close.
- Users (10): list, soft delete, restore, restricciones de rol.
- SLA (9): cálculo de dueAt por prioridad, isOverdue por status.

Mockean Prisma con `vitest-mock-extended` y nodemailer; corren sin DB
ni SMTP reales.

```bash
npm test           # one-shot
npm run test:watch # dev
```

## CI

GitHub Actions corre en cada push y PR a `main`:

1. `npm ci`
2. `npx prisma generate`
3. `npx tsc --noEmit` (typecheck)
4. `npm test` (60 tests)

Ver [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Deploy

Actualmente desplegado en **Render**. Build command:

```
npm ci && npm run build
```

Pre-deploy command (debe ejecutarse una vez antes de arrancar la nueva
versión):

```
npm run db:migrate
```

Start command:

```
npm start
```

`npm run build` nunca modifica la base. Las migraciones de staging y
producción deben aplicarse exclusivamente con `prisma migrate deploy`; no usar
`prisma db push` ni `--accept-data-loss` en esos entornos. Si el plan de Render
no ofrece Pre-Deploy Command, ejecutar `npm run db:migrate` como tarea manual
contra la `DATABASE_URL` correspondiente antes de desplegar el backend.

Variables de entorno requeridas en Render: las mismas del `.env.example`
local (con `NODE_ENV=production`).

## Licencia

Propietario. Ver [LICENSE.md](./LICENSE.md).

## Autor

Iván Luis Leiva.
