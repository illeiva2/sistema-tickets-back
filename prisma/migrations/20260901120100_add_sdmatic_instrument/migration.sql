-- Instrumento visible del SDmatic 2. En migracion aparte de la que crea el valor
-- de enum, por la regla de transacciones de Postgres.
--
-- El SDmatic no expone un serial de hardware en sus CSV, asi que se usa uno
-- sintetico estable ("SDMATIC2"): hay un solo equipo. Igual que con el FN, NO se
-- siembra fila en lab_feeds: la crea el primer heartbeat del agente, asi el
-- watchdog no abre un ticket falso antes de que arranque.
--
-- Solo INSERT idempotente. No destructivo.
INSERT INTO "lab_instruments" ("serial", "source", "displayName", "location", "isActive")
VALUES ('SDMATIC2', 'SDMATIC', 'SDmatic 2 (almidón dañado)', 'Molino', true)
ON CONFLICT ("serial") DO NOTHING;
