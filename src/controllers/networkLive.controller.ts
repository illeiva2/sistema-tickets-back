import { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors";
import { validate } from "../middleware/validation";
import NetworkLiveService, { CollectorSnapshotInput } from "../services/networkLive.service";
import { collectorSnapshotSchema } from "../validations/networkLive";

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
