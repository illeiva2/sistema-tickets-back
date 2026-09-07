-- Atributos de calidad del grano como condiciones de la muestra.
--
-- 1) Tipo de campo BOOLEAN (casilla si/no): la presencia de una alteracion
--    (brotado, panza blanca, carbon...) es binaria, no una escala.
-- 2) Cada campo puede marcarse como CONDICION: si esta presente, la muestra
--    lleva una advertencia en la lista, la ficha y al registrarla. Para las
--    listas (insectos, olor), conditionValues dice que opciones cuentan.
--
-- Solo ALTER TYPE ADD VALUE y ADD COLUMN con default. Nada destructivo. El
-- valor nuevo del enum no se usa en esta misma migracion (Postgres no lo
-- permite dentro de la transaccion que lo crea); los campos se convierten con
-- un script aparte, despues del deploy.

-- AlterEnum
ALTER TYPE "LabFieldType" ADD VALUE 'BOOLEAN';

-- AlterTable
ALTER TABLE "lab_sample_field_defs" ADD COLUMN "isCondition" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "conditionValues" JSONB;
