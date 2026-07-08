import { Request, Response, NextFunction } from "express";
import { KbSuggestionsService } from "../services/kbSuggestions.service";
import { isFinnegansKbConfigured, type KbModo } from "../lib/finnegansKb";

// Controlador de la Base de Conocimiento oficial de Finnegans.
// Proxy delgado sobre KbSuggestionsService; sigue el shape de respuesta del
// resto de la API: { success: true, data }.

const MODOS: KbModo[] = ["hibrido", "semantico", "palabras"];

function parseModo(v: unknown): KbModo {
  const m = String(v ?? "hibrido") as KbModo;
  return MODOS.includes(m) ? m : "hibrido";
}

function parseLimit(v: unknown): number {
  const n = Number(v ?? 5);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(Math.trunc(n), 1), 20);
}

export class KbController {
  // GET /api/kb/status — si la KB esta configurada (para que el front muestre
  // u oculte la UI de sugerencias). No requiere rol especial.
  static status = async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: { configured: isFinnegansKbConfigured() },
    });
  };

  // GET /api/kb/buscar?q=...&limit=5&modo=hibrido — busqueda libre en la KB.
  static buscar = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
        });
      }
      const q = String(req.query.q ?? "");
      const result = await KbSuggestionsService.buscarLibre(
        q,
        parseLimit(req.query.limit),
        parseModo(req.query.modo),
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  // GET /api/kb/tickets/:ticketId/suggestions — articulos oficiales sugeridos
  // para un ticket. Solo staff (AGENT/ADMIN); la respuesta incluye texto del
  // ticket, por eso no se expone a usuarios comunes.
  static suggestionsForTicket = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
        });
      }
      const { ticketId } = req.params;
      const result = await KbSuggestionsService.forTicket(
        ticketId,
        parseLimit(req.query.limit),
        parseModo(req.query.modo),
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };
}

export default KbController;
