-- Red en vivo: PoE por puerto (estado, potencia entregada y clase) y del switch (potencia nominal
-- y en uso), que informa el colector 0.4.
-- Aditiva: sólo columnas nuevas que admiten null; no toca datos existentes.

-- AlterTable
ALTER TABLE "network_live_devices" ADD COLUMN "poeBudgetW" DOUBLE PRECISION,
ADD COLUMN "poeUsedW" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "network_live_ports" ADD COLUMN "poeStatus" VARCHAR(12),
ADD COLUMN "poePowerW" DOUBLE PRECISION,
ADD COLUMN "poeClass" INTEGER;
