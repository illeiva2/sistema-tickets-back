-- Agrega el Chopin AlveoLab (alveógrafo) como quinto origen de laboratorio.
-- Solo el ALTER TYPE, en su propia migracion: Postgres no deja usar un valor de
-- enum recien creado en la misma transaccion. No destructivo.
ALTER TYPE "LabSource" ADD VALUE IF NOT EXISTS 'ALVEOLAB';
