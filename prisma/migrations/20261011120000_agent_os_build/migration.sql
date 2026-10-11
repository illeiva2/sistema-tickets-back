-- Build del sistema operativo informado por el agente ("26100.4061"). Hasta ahora
-- se descartaba cuando venía la versión comercial ("24H2"), y es el único dato que
-- distingue Windows 10 de 11 (build 22000+). Aditiva: no toca datos existentes; el
-- próximo heartbeat de cada equipo la completa.

ALTER TABLE "agent_devices" ADD COLUMN "osBuild" TEXT;
