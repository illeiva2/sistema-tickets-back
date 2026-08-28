-- Agrega el Perten FN 1000 (Falling Number) como tercer origen de laboratorio.
--
-- Va SOLO el ALTER TYPE, en su propia migracion. En Postgres, un valor de enum
-- recien agregado no se puede USAR en la misma transaccion que lo crea (error
-- "unsafe use of new value"). Sembrar el instrumento con source='FN' va en la
-- migracion siguiente, ya en otra transaccion.
--
-- No destructivo.
ALTER TYPE "LabSource" ADD VALUE IF NOT EXISTS 'FN';
