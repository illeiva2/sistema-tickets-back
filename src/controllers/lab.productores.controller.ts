import { NextFunction, Request, Response } from "express";
import LabProductoresService from "../services/lab.productores.service";

/** Estado de la lista de empresas de granos que trae el job nocturno. */
export default class LabProductoresController {
  static status = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await LabProductoresService.estado() });
    } catch (err) {
      next(err);
    }
  };
}
