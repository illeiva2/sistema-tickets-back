-- Empresas de granos del ERP (tag GRANOS) para sugerir en "Empresa" de la
-- muestra de recepción, y el registro de cada corrida del job que las trae.
-- Aditiva: tablas nuevas, no toca datos existentes.

CREATE TABLE "lab_productores" (
    "id" INTEGER NOT NULL,
    "cuit" VARCHAR(20),
    "codigo" VARCHAR(40),
    "nombre" VARCHAR(200) NOT NULL,
    "razonSocial" VARCHAR(200),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "esProveedor" BOOLEAN NOT NULL DEFAULT false,
    "esCliente" BOOLEAN NOT NULL DEFAULT false,
    "tagCompras" BOOLEAN NOT NULL DEFAULT false,
    "tagVentas" BOOLEAN NOT NULL DEFAULT false,
    "localidad" VARCHAR(120),
    "provincia" VARCHAR(80),
    "localidadAfip" VARCHAR(20),
    "base" VARCHAR(40),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "lab_productores_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lab_productores_nombre_idx" ON "lab_productores"("nombre");

CREATE TABLE "lab_productor_syncs" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL,
    "dataset" VARCHAR(80),
    "total" INTEGER,
    "upserted" INTEGER,
    "removed" INTEGER,
    "error" VARCHAR(500),

    CONSTRAINT "lab_productor_syncs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lab_productor_syncs_startedAt_idx" ON "lab_productor_syncs"("startedAt");
