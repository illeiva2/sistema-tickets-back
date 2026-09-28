import { NextFunction, Request, Response } from "express";
import LabManualService from "../services/lab.manual.service";

/** Análisis manuales de una muestra (termobalanza, estufa, colorímetro, PMG). */

const handler =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

export default class LabManualController {
  // req.user lo garantiza authMiddleware, que corre antes en el router.
  static create = handler((req) => LabManualService.crear(req.params.id, req.user!.id, req.body), 201);
  static update = handler((req) => LabManualService.actualizar(req.params.id, req.body));
  static remove = handler((req) => LabManualService.eliminar(req.params.id));
}
