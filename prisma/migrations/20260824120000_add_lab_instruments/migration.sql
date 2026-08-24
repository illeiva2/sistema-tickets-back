-- Nombres visibles de los instrumentos del laboratorio.
--
-- En el molino esto vive en dbo.EquipmentMapping, que no viaja en el espejo: el
-- agente manda el serial y nada mas. Sin esta tabla el panel mostraria
-- "2415480" en lugar de "Laboratorio molino".
--
-- Solo CREATE e INSERT. Nada destructivo.

CREATE TABLE "lab_instruments" (
    "serial"      VARCHAR(64) NOT NULL,
    "source"      "LabSource" NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "location"    VARCHAR(80),
    "isActive"    BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "lab_instruments_pkey" PRIMARY KEY ("serial")
);

CREATE INDEX "lab_instruments_source_isActive_idx"
    ON "lab_instruments"("source", "isActive");

-- Los tres instrumentos que hoy alimentan la base, con los nombres que ya
-- estaban en uso en el molino. Se siembran aca y no en un script aparte: si la
-- tabla nace vacia, el selector de equipos aparece vacio y el panel se ve roto
-- en su primer arranque.
--
-- ON CONFLICT para que la migracion sea idempotente y para no pisar un nombre
-- que alguien haya corregido despues a mano.
INSERT INTO "lab_instruments" ("serial", "source", "displayName", "location", "isActive")
VALUES
    ('2113965', 'GLUTOMATIC', 'Balanza acopio',          'Acopio', true),
    ('2415480', 'GLUTOMATIC', 'Laboratorio molino',      'Molino', true),
    ('2405833', 'NIR',        'NIR Inframatic IM 9500H', 'Molino', true)
ON CONFLICT ("serial") DO NOTHING;
