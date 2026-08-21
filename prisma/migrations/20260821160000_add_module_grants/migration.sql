-- Permisos de acceso por modulo, por usuario.
-- Solo CREATE: no modifica ni borra nada de lo existente.

CREATE TABLE "module_grants" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "moduleKey"   VARCHAR(40) NOT NULL,
    "level"       TEXT NOT NULL DEFAULT 'VIEWER',
    "grantedById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"   TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "module_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "module_grants_userId_moduleKey_revokedAt_idx"
    ON "module_grants"("userId", "moduleKey", "revokedAt");

CREATE INDEX "module_grants_moduleKey_idx"
    ON "module_grants"("moduleKey");

-- Unicidad de la concesion ACTIVA. Parcial a proposito: permite conservar el
-- historial de concesiones revocadas del mismo usuario y modulo. Prisma no sabe
-- declarar indices parciales, por eso va escrito a mano aca.
CREATE UNIQUE INDEX "module_grants_active_uq"
    ON "module_grants"("userId", "moduleKey")
    WHERE "revokedAt" IS NULL;

ALTER TABLE "module_grants"
    ADD CONSTRAINT "module_grants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "module_grants"
    ADD CONSTRAINT "module_grants_grantedById_fkey"
    FOREIGN KEY ("grantedById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
