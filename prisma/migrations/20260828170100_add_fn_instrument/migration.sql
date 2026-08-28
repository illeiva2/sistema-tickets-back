-- Instrumento visible del FN 1000. Va en migracion aparte de la que crea el
-- valor de enum 'FN', porque Postgres no deja usar un valor de enum recien
-- creado en la misma transaccion.
--
-- NO se siembra fila en lab_feeds a proposito: si existiera con lastHeartbeat
-- nulo, el watchdog la veria como CAIDA y abriria un ticket falso de "sin datos
-- de FN" antes de que el agente arranque. La fila del feed la crea el primer
-- heartbeat del agente (recordHeartbeat hace upsert), asi el monitoreo empieza
-- recien despues del primer contacto: "sin comisionar" != "caido".
--
-- Solo INSERT idempotente. No destructivo.
INSERT INTO "lab_instruments" ("serial", "source", "displayName", "location", "isActive")
VALUES ('1916318', 'FN', 'FN 1000 (Falling Number)', 'Molino', true)
ON CONFLICT ("serial") DO NOTHING;
