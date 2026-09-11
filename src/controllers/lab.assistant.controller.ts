import { NextFunction, Request, Response } from "express";
import LabAssistantService, { type RelayInfo } from "../services/lab.assistant.service";

/** El controller solo traduce; la regla vive en el service. */
const handler =
  (fn: (req: Request, res: Response) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req, res) });
    } catch (err) {
      next(err);
    }
  };

const MAX_WAIT_S = 25;

export class LabAssistantController {
  // ─── Usuarios (authMiddleware + requireModule corren antes en el router) ──

  static status = handler(() => LabAssistantService.status());

  static ask = handler(
    (req) => LabAssistantService.ask(req.user!.id, req.body.question, req.body.history ?? []),
    201,
  );

  static get = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = await LabAssistantService.get(req.user!.id, String(req.params.id));
      if (!d) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "No existe esa consulta" },
        });
      }
      res.json({ success: true, data: d });
    } catch (err) {
      next(err);
    }
  };

  // ─── Relé (serviceAuthMiddleware deja el slug en res.locals) ──────────────

  static nextJob = handler((req, res) => {
    const q = req.query as { wait?: number; model?: string; version?: string; gpu?: string };
    const waitS = Math.min(Number(q.wait ?? 20), MAX_WAIT_S);
    const info: RelayInfo = {
      model: q.model,
      version: q.version,
      gpu: q.gpu === undefined ? undefined : q.gpu === "1" || q.gpu === "true",
    };
    return LabAssistantService.nextJob(String(res.locals.serviceClientSlug), waitS * 1000, info);
  });

  static jobResult = handler((req, res) =>
    LabAssistantService.jobResult(String(res.locals.serviceClientSlug), String(req.params.id), req.body),
  );
}

export default LabAssistantController;
