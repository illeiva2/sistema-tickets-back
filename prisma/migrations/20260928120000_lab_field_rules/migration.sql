-- Reglas del catálogo de campos (reunión con laboratorios y acopio del 28-sep-2026):
-- visibilidad condicional, formato, porcentaje en casillas, sugerencias y
-- mayúsculas por campo; laboratorio fijo por tipo de muestra. Aditivo.
ALTER TABLE "lab_sample_kinds" ADD COLUMN "lockSite" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "lab_sample_field_defs"
  ADD COLUMN "visibleWhen" JSONB,
  ADD COLUMN "pattern" VARCHAR(200),
  ADD COLUMN "patternHint" VARCHAR(120),
  ADD COLUMN "withPercent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "suggest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "uppercase" BOOLEAN NOT NULL DEFAULT false;
