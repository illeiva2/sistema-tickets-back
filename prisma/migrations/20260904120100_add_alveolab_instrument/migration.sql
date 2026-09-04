-- Instrumento visible del AlveoLab. En migracion aparte de la que crea el valor
-- de enum, por la regla de transacciones de Postgres.
--
-- El AlveoLab SI expone un serial en su base ("391", en Test.SN, igual para las
-- ~3.900 pruebas): hay un solo equipo. Igual que con el FN y el SDmatic, NO se
-- siembra fila en lab_feeds: la crea el primer heartbeat del agente, asi el
-- watchdog no abre un ticket falso antes de que arranque.
--
-- Solo INSERT idempotente. No destructivo.
INSERT INTO "lab_instruments" ("serial", "source", "displayName", "location", "isActive")
VALUES ('391', 'ALVEOLAB', 'AlveoLab (Chopin)', 'Laboratorio molino', true)
ON CONFLICT ("serial") DO NOTHING;
