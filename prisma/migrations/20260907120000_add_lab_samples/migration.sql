-- Registro de muestras del laboratorio.
--
-- La muestra es la unidad que enlaza los analisis de los cinco instrumentos:
-- se registra UNA vez, recibe una accesion corta (M-0012-4) que el operario
-- tipea en cada equipo, y las mediciones se enlazan leyendo esa accesion del
-- sampleRef. La metadata vive en la ficha (campos configurables por tipo de
-- muestra), no en el nombre que se tipea.
--
-- Solo CREATE e INSERT. Nada destructivo.

-- CreateEnum
CREATE TYPE "LabSite" AS ENUM ('MOLINO', 'ACOPIO');

-- CreateEnum
CREATE TYPE "LabFieldType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'DATETIME');

-- CreateTable
CREATE TABLE "lab_sample_kinds" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(200),
    "defaultSite" "LabSite",
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_sample_kinds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_sample_field_defs" (
    "id" TEXT NOT NULL,
    "kindId" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "type" "LabFieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "inName" BOOLEAN NOT NULL DEFAULT false,
    "namePrefix" VARCHAR(20),
    "placeholder" VARCHAR(80),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_sample_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_samples" (
    "id" TEXT NOT NULL,
    "accession" VARCHAR(16) NOT NULL,
    "site" "LabSite" NOT NULL,
    "seq" INTEGER NOT NULL,
    "kindId" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "fields" JSONB NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "lab_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lab_sample_kinds_code_key" ON "lab_sample_kinds"("code");

-- CreateIndex
CREATE INDEX "lab_sample_field_defs_kindId_isActive_sortOrder_idx" ON "lab_sample_field_defs"("kindId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "lab_sample_field_defs_kindId_key_key" ON "lab_sample_field_defs"("kindId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "lab_samples_accession_key" ON "lab_samples"("accession");

-- CreateIndex
CREATE INDEX "lab_samples_sampledAt_idx" ON "lab_samples"("sampledAt");

-- CreateIndex
CREATE INDEX "lab_samples_kindId_sampledAt_idx" ON "lab_samples"("kindId", "sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "lab_samples_site_seq_key" ON "lab_samples"("site", "seq");

-- AddForeignKey
ALTER TABLE "lab_sample_field_defs" ADD CONSTRAINT "lab_sample_field_defs_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "lab_sample_kinds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_kindId_fkey" FOREIGN KEY ("kindId") REFERENCES "lab_sample_kinds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Correlativos por laboratorio. Secuencias y no una columna contador: nextval()
-- es atomico sin bloquear filas, y los huecos que dejan las transacciones
-- abortadas son deseables, porque una accesion jamas se reutiliza. Prisma no
-- las modela, por eso viven aca; el service las nombra por sitio.
CREATE SEQUENCE IF NOT EXISTS "lab_sample_seq_molino" AS INTEGER START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS "lab_sample_seq_acopio" AS INTEGER START WITH 1 INCREMENT BY 1;

-- Tipos de muestra iniciales. Se siembran aca y no en un script aparte: si la
-- tabla nace vacia, el formulario de registro no tiene que ofrecer y el modulo
-- se ve roto en su primer arranque. Ids fijos y legibles para poder
-- referenciarlos desde otras migraciones.
--
-- ON CONFLICT DO NOTHING: la migracion es idempotente y no pisa lo que los
-- laboratorios hayan corregido despues desde el panel.
INSERT INTO "lab_sample_kinds" ("id", "code", "name", "description", "defaultSite", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
    ('lsk_interna',   'INTERNA',   'Muestra interna de proceso',
     'Corrientes del molino por turno: trigo, harinas, semitas y afrechillos.', 'MOLINO', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsk_recepcion', 'RECEPCION', 'Recepción de grano',
     'Grano que llega: empresa, procedencia, carta de porte, CTG y transporte.', 'ACOPIO', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Campos de la muestra INTERNA: la identidad que usa el "Reporte de analisis
-- diario" del molino (turno, producto, lote). La fecha/hora de la toma no es
-- un campo: es sampledAt. Los 15 productos son las corrientes de ese reporte.
INSERT INTO "lab_sample_field_defs" ("id", "kindId", "key", "label", "type", "required", "options", "inName", "namePrefix", "placeholder", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
    ('lsf_int_turno', 'lsk_interna', 'turno', 'Turno', 'SELECT', true,
     '["1° Noche (22:00–06:00)", "2° Mañana (07:00–14:00)", "3° Tarde (15:00–21:00)"]'::jsonb,
     false, NULL, NULL, 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_int_producto', 'lsk_interna', 'producto', 'Producto', 'SELECT', true,
     '["Trigo Sucio", "Trigo Limpio", "Trigo Acondicionado", "Primera Rotura", "3/0", "4/0", "Tapera", "Semolín", "Semita C4", "Semita C5", "Afrechillo Fino", "Afrechillo Grueso", "3/0 Embolse", "4/0 Embolse", "Tapera Embolse"]'::jsonb,
     true, NULL, NULL, 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_int_lote', 'lsk_interna', 'lote', 'Lote', 'TEXT', false,
     NULL, true, 'Lote ', 'Ej.: 4521', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- Campos de la RECEPCION de grano: los que se fijaron el 7-sep-2026 para
-- destrabar el desarrollo (fecha/hora es sampledAt). Faltantes probables, a
-- sumar desde el panel: numero de transporte y lo que pida Finnegans.
INSERT INTO "lab_sample_field_defs" ("id", "kindId", "key", "label", "type", "required", "options", "inName", "namePrefix", "placeholder", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
    ('lsf_rec_empresa',     'lsk_recepcion', 'empresa',     'Empresa',              'TEXT', true,  NULL, true,  NULL,    'Razón social del remitente',        1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_procedencia', 'lsk_recepcion', 'procedencia', 'Procedencia',          'TEXT', true,  NULL, true,  NULL,    'Localidad, campo u origen',         2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_silo',        'lsk_recepcion', 'silo',        'Silo (Molino Forzani)','TEXT', false, NULL, true,  'Silo ', 'Ej.: 12',                          3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_ctg',         'lsk_recepcion', 'ctg',         'CTG',                  'TEXT', false, NULL, false, NULL,    'Código de trazabilidad de granos',  4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_carta_porte', 'lsk_recepcion', 'carta_porte', 'Carta de porte',       'TEXT', false, NULL, false, NULL,    'Número de carta de porte',          5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_chofer',      'lsk_recepcion', 'chofer',      'Chofer',               'TEXT', false, NULL, false, NULL,    NULL,                                6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_patente',     'lsk_recepcion', 'patente',     'Patente (camión)',     'TEXT', false, NULL, false, NULL,    'AA123BB',                           7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('lsf_rec_acoplado',    'lsk_recepcion', 'acoplado',    'Acoplado (patente)',   'TEXT', false, NULL, false, NULL,    NULL,                                8, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
