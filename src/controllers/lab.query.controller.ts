import { NextFunction, Request, Response } from "express";
import LabQueryService, {
  type FiltrosGluten,
  type FiltrosNir,
} from "../services/lab.query.service";

/**
 * Lectura del módulo de laboratorio. Todo esto lo consume el panel, así que las
 * respuestas conservan exactamente las formas que ya usaba el dashboard .NET:
 * el port del frontend es mecánico y no hay que re-mapear nada.
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

const booleano = (v: unknown): boolean => texto(v) === "true";

const filtrosGluten = (q: Request["query"]): FiltrosGluten => ({
  from: texto(q.from),
  to: texto(q.to),
  instrumentSerial: texto(q.instrumentSerial),
  method: texto(q.method),
  sampleCodeContains: texto(q.sampleCodeContains),
  includeIncomplete: booleano(q.includeIncomplete),
});

const filtrosNir = (q: Request["query"]): FiltrosNir => ({
  product: texto(q.product),
  from: texto(q.from),
  to: texto(q.to),
  sampleCodeContains: texto(q.sampleCodeContains),
});

/** Envuelve un handler para no repetir try/catch en cada uno. */
const handler =
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

export class LabQueryController {
  static equipos = handler(() => LabQueryService.equipos());

  static metodos = handler(() => LabQueryService.metodos());

  static mediciones = handler((req) =>
    LabQueryService.mediciones(
      filtrosGluten(req.query),
      entero(req.query.page, 1),
      entero(req.query.pageSize, 50),
      texto(req.query.sortBy) ?? "analyzedAt",
      texto(req.query.sortDesc) !== "false",
    ),
  );

  static estadisticas = handler((req) =>
    LabQueryService.estadisticas(filtrosGluten(req.query)),
  );

  static harinas = handler((req) => LabQueryService.harinas(filtrosGluten(req.query)));

  static tendenciaMensual = handler((req) =>
    LabQueryService.tendenciaMensual(
      entero(req.query.months, 12),
      texto(req.query.serial),
      texto(req.query.method),
      // Ausente = incluir. Solo un "false" explícito las excluye, igual que en
      // el resto de los filtros.
      texto(req.query.includeIncomplete) !== "false",
    ),
  );

  static tendenciaDiaria = handler((req) =>
    LabQueryService.tendenciaDiaria(filtrosGluten(req.query), entero(req.query.days, 30)),
  );

  static resumen = handler(() => LabQueryService.resumen());

  static detalle = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = await LabQueryService.detalle(String(req.params.id));
      if (!d) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "No existe esa medición" },
        });
      }
      res.json({ success: true, data: d });
    } catch (err) {
      next(err);
    }
  };

  static nirProductos = handler(() => LabQueryService.nirProductos());

  static nirMediciones = handler((req) =>
    LabQueryService.nirMediciones(
      filtrosNir(req.query),
      entero(req.query.page, 1),
      entero(req.query.pageSize, 50),
    ),
  );

  static nirEstadisticas = handler((req) =>
    LabQueryService.nirEstadisticas(filtrosNir(req.query)),
  );

  static nirTendencia = handler((req) =>
    LabQueryService.nirTendencia(filtrosNir(req.query), entero(req.query.days, 60)),
  );
}

export default LabQueryController;
