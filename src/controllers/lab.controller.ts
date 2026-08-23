import { Response, NextFunction, Request } from "express";
import { LabSource } from "@prisma/client";
import LabService, {
  type HeartbeatPayload,
  type IngestMeasurement,
} from "../services/lab.service";
import { logger } from "../lib/logger";
import { pingDeadMansSwitch } from "../services/lab.watchdog";

// El tsconfig de este repo no tiene `strict`, y sin strictNullChecks la
// inferencia de Zod colapsa a "todo opcional". Los tipos de abajo describen lo
// que el schema YA garantizó en runtime: validate() corre antes que el handler.
type IngestBatchBody = {
  source: LabSource;
  measurements: IngestMeasurement[];
  cursorId?: string;
};
type HeartbeatBody = HeartbeatPayload & { source: LabSource };

export class LabController {
  /** Lote de mediciones desde el agente del molino. Idempotente. */
  static ingestBatch = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as unknown as IngestBatchBody;
      const source = body.source;

      const result = await LabService.ingestBatch(source, body.measurements);

      // El cursor avanza SOLO si no hubo fallos: si una fila del lote no entró,
      // avanzar dejaría un hueco permanente que nadie detectaría hasta el
      // reconcile. Es preferible reprocesar el lote entero en la próxima corrida.
      if (body.cursorId && result.failed === 0) {
        await LabService.advanceCursor(source, body.cursorId, result.maxAnalyzedAt);
      }

      if (result.failed > 0) {
        logger.warn(
          { source, ...result, client: res.locals.serviceClientSlug },
          "Lote de laboratorio con mediciones rechazadas: el cursor NO avanza",
        );
      }

      res.json({
        success: true,
        data: {
          inserted: result.inserted,
          updated: result.updated,
          failed: result.failed,
          cursorAdvanced: !!body.cursorId && result.failed === 0,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Marca de vida del agente. Se llama en cada corrida aunque no haya nada nuevo:
   * es lo que permite distinguir un enlace caído de un día sin mediciones.
   */
  static heartbeat = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as unknown as HeartbeatBody;
      const feed = await LabService.recordHeartbeat(body.source, body);

      // Después de commitear, no antes: así el ping afirma "el dato quedó en la
      // base", no "me llegó una request". Fire-and-forget.
      if (body.sqlReachable) void pingDeadMansSwitch();

      res.json({
        success: true,
        data: {
          source: feed.source,
          cursorId: feed.cursorId,
          acknowledgedAt: feed.lastHeartbeatAt,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * El agente manda su resumen por día; el servidor responde qué días no
   * cuadran. El agente re-empuja esos días completos: como todo es upsert,
   * re-enviar un día entero es inofensivo.
   */
  static reconcile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as unknown as {
        source: LabSource;
        days: { day: string; count: number; valueSum: number }[];
      };
      const result = await LabService.reconcile(body.source, body.days);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  /** Cursor desde el que el agente debe seguir. Lo consulta al arrancar. */
  static cursor = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await LabService.getHealth();
      const source = String(req.query.source ?? "").toUpperCase();
      const found = health.sources.find((s) => s.source === source);
      if (!found) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Origen desconocido" },
        });
      }
      res.json({ success: true, data: found });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Salud del espejo. La consumen el banner de frescura del dashboard y el
   * watchdog. Devuelve estado DERIVADO por edad, nunca uno guardado.
   */
  static health = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await LabService.getHealth() });
    } catch (err) {
      next(err);
    }
  };
}

export default LabController;
