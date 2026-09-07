import { NextFunction, Request, Response } from "express";
import type { LabSite } from "@prisma/client";
import LabSamplesService, { type FiltrosMuestras } from "../services/lab.samples.service";
import LabReportService from "../services/lab.report.service";

/**
 * Registro de muestras. Misma disciplina que el resto del módulo: el controller
 * solo traduce query/params y deja la regla en el service.
 */

const texto = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
};

const entero = (v: unknown, porDefecto: number): number => {
  const n = Number(texto(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto;
};

const sitio = (v: unknown): LabSite | undefined =>
  v === "MOLINO" || v === "ACOPIO" ? v : undefined;

const filtros = (q: Request["query"]): FiltrosMuestras => ({
  site: sitio(q.site),
  kindId: texto(q.kindId),
  q: texto(q.q),
  from: texto(q.from),
  to: texto(q.to),
});

/** Páginas acotadas: la lista es para operar, no para exportar el histórico. */
const MAX_PAGE_SIZE = 200;

const handler =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

/** Como `handler`, pero un resultado null es 404 con el mensaje dado. */
const oNoEncontrado =
  (mensaje: string) =>
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = await fn(req);
      if (!d) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: mensaje },
        });
      }
      res.json({ success: true, data: d });
    } catch (err) {
      next(err);
    }
  };

export class LabSamplesController {
  static kinds = handler((req) =>
    LabSamplesService.kinds(texto(req.query.includeInactive) === "true"),
  );

  static summary = handler(() => LabSamplesService.summary());

  /** Reporte de análisis diario (turno × producto). Sin fecha = hoy, en fecha de planta. */
  static dailyReport = handler((req) => LabReportService.diario(texto(req.query.date)));

  static list = handler((req) =>
    LabSamplesService.list(
      filtros(req.query),
      entero(req.query.page, 1),
      Math.min(entero(req.query.pageSize, 50), MAX_PAGE_SIZE),
    ),
  );

  static getByAccession = oNoEncontrado("No existe una muestra con esa accesión")((req) =>
    LabSamplesService.getByAccession(String(req.params.accession)),
  );

  // req.user lo garantiza authMiddleware, que corre antes en el router.
  static create = handler((req) => LabSamplesService.create(req.user!.id, req.body), 201);

  /** Ventana acotada: re-enlazar el histórico entero no tiene sentido, las accesiones son nuevas. */
  static relink = handler((req) =>
    LabSamplesService.relinkUnlinked(Math.min(entero(req.query.days, 30), 365)),
  );

  static update = oNoEncontrado("No existe esa muestra")((req) =>
    LabSamplesService.update(String(req.params.id), req.body),
  );

  static createFieldDef = handler(
    (req) => LabSamplesService.createFieldDef(String(req.params.kindId), req.body),
    201,
  );

  static updateFieldDef = oNoEncontrado("No existe ese campo")((req) =>
    LabSamplesService.updateFieldDef(String(req.params.id), req.body),
  );
}

export default LabSamplesController;
