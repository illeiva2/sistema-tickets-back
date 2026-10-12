import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { validate } from "../middleware/validation";
import NetworkLiveService, { CollectorSnapshotInput } from "../services/networkLive.service";
import NetworkWatchdog from "../services/networkLive.watchdog";
import {
  collectorSnapshotSchema,
  networkLiveEventsSchema,
  networkLiveMuteSchema,
  networkLiveSearchSchema,
} from "../validations/networkLive";

const DEFAULT_EVENTS_WINDOW_MS = 24 * 60 * 60_000;

export class NetworkLiveController {
  /** Envío del colector de la planta: credencial de servicio, no una persona. */
  static ingest = [
    validate(collectorSnapshotSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const collector = res.locals.serviceClientSlug as string | undefined;
        if (!collector) {
          throw new ApiError("SERVICE_AUTH_INVALID", "Credenciales de servicio inválidas", 401);
        }
        const result = await NetworkLiveService.ingestSnapshot(
          collector,
          req.body as CollectorSnapshotInput,
        );
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  /** "¿Dónde está X?": por MAC, IP, nombre DHCP, nombre de la PC o usuario logueado. */
  static search = [
    validate(z.object({ query: networkLiveSearchSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json({ success: true, data: await NetworkLiveService.search(String(req.query.q)) });
      } catch (error) {
        next(error);
      }
    },
  ];

  /** Historial: qué cambió en la red (equipos, puertos, enlaces, equipos finales). */
  static events = [
    validate(z.object({ query: networkLiveEventsSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query = req.query as unknown as {
          since?: Date;
          until?: Date;
          deviceId?: string;
          portKey?: string;
          mac?: string;
          kinds?: string[];
          limit: number;
        };
        const since = query.since ?? new Date(Date.now() - DEFAULT_EVENTS_WINDOW_MS);
        res.json({ success: true, data: await NetworkLiveService.events({ ...query, since }) });
      } catch (error) {
        next(error);
      }
    },
  ];

  /** Silenciar las alertas de un equipo (sólo ADMIN): cierra su aviso abierto sin notificar. */
  static muteAlerts = [
    validate(networkLiveMuteSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const device = await NetworkWatchdog.setMuted(String(req.params.id), Boolean(req.body.muted));
        if (!device) throw new ApiError("NOT_FOUND", "No existe ese equipo de red", 404);
        res.json({ success: true, data: device });
      } catch (error) {
        next(error);
      }
    },
  ];

  /** Pantalla "Red en vivo": equipos, puertos y enlaces del último envío. */
  static view = [
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json({ success: true, data: await NetworkLiveService.liveView() });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default NetworkLiveController;
