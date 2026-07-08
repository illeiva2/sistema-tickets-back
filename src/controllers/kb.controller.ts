import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { KbSuggestionsService } from "../services/kbSuggestions.service";
import { isFinnegansKbConfigured } from "../lib/finnegansKb";

// Controlador de la Base de Conocimiento oficial de Finnegans (bc.finneg.com).
// Proxy delgado sobre KbSuggestionsService; sigue el shape de respuesta del
// resto de la API: { success: true, data }.

function parseLimit(v: unknown): number {
  const n = Number(v ?? 5);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(Math.trunc(n), 1), 20);
}

export class KbController {
  // GET /api/kb/status — si la KB esta habilitada (el front decide si
  // muestra u oculta la UI de sugerencias oficiales).
  static status = async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: { configured: isFinnegansKbConfigured() },
    });
  };

  // GET /api/kb/buscar?q=...&limit=5 — busqueda libre en la KB oficial.
  static buscar = async (
    req: AuthenticatedRequest,
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
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  // GET /api/kb/tickets/:ticketId/suggestions — articulos oficiales
  // sugeridos para un ticket. Solo staff (la ruta exige AGENT/ADMIN);
  // el service ademas valida que un AGENT pueda ver ese ticket.
  static suggestionsForTicket = async (
    req: AuthenticatedRequest,
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
        req.user.id,
        req.user.role,
        parseLimit(req.query.limit),
      );
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };
}

export default KbController;
