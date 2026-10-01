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

const booleano = (v: unknown): boolean | undefined =>
  v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined;

const CLAVE_CAMPO = /^[a-z][a-z0-9_]{1,39}$/;
/** Tope de filtros por campo: una URL armada a mano no tiene por qué armar una consulta absurda. */
const MAX_FILTROS_CAMPO = 5;

/**
 * Filtros por campo de la ficha: `f.<clave>=<valor>`, uno por campo
 * (`?f.tipo_ingreso=Camión`). Planos a propósito: Express parsea anidados,
 * pero `f.x` se lee igual en un log, en una URL compartida y en el cliente.
 */
const camposDe = (q: Request["query"]): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith("f.")) continue;
    const key = k.slice(2);
    const val = texto(v);
    if (!CLAVE_CAMPO.test(key) || !val || val.length > 80) continue;
    out[key] = val;
    if (Object.keys(out).length >= MAX_FILTROS_CAMPO) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const filtros = (q: Request["query"]): FiltrosMuestras => ({
  site: sitio(q.site),
  kindId: texto(q.kindId),
  q: texto(q.q),
  from: texto(q.from),
  to: texto(q.to),
  fields: camposDe(q),
  rejected: booleano(q.rejected),
});

/** Páginas acotadas: la lista es para operar, no para exportar el histórico. */
const MAX_PAGE_SIZE = 200;

/**
 * La grilla no pagina: trae el filtro entero hasta este tope y el navegador
 * ordena. 500 son semanas de muestras; el tope duro evita que un filtro sin
 * fechas arrastre el histórico completo.
 */
const GRID_LIMIT = 500;
const GRID_MAX_LIMIT = 1000;

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

  /** Grilla de consulta: muestras del filtro con la ficha y los análisis pivoteados por columna. */
  static grid = handler((req) =>
    LabSamplesService.grid(
      filtros(req.query),
      Math.min(entero(req.query.limit, GRID_LIMIT), GRID_MAX_LIMIT),
    ),
  );

  /** Valores ya cargados para un campo con sugerencias (empresa, procedencia…). */
  static suggest = handler((req) =>
    LabSamplesService.suggest(texto(req.query.kindId), texto(req.query.key) ?? ""),
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

  /** Camión rechazado, con su motivo. El cuerpo lo valida rejectSampleSchema. */
  static reject = oNoEncontrado("No existe esa muestra")((req) =>
    LabSamplesService.reject(String(req.params.id), req.user!.id, String(req.body.reason)),
  );

  static unreject = oNoEncontrado("No existe esa muestra")((req) =>
    LabSamplesService.unreject(String(req.params.id)),
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
