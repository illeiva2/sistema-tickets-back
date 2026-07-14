import { Response, NextFunction } from "express";
import { z } from "zod";
import { validate } from "../middleware/validation";
import { AuthenticatedRequest } from "../middleware/auth";
import TicketAssistantService from "../services/ticketAssistant.service";
import { isAnthropicConfigured } from "../lib/anthropic";
import { assistantChatSchema } from "../validations/assistant";

export class AssistantController {
  // GET /api/assistant/status — el front oculta la UI del asistente si la
  // IA no está configurada en el servidor.
  static status = async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      success: true,
      data: { configured: isAnthropicConfigured() },
    });
  };

  // POST /api/assistant/chat — un turno de conversación. El cliente manda
  // la conversación completa (limpia) y recibe la respuesta + fuentes.
  static chat = [
    validate(z.object({ body: assistantChatSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({
            success: false,
            error: { code: "UNAUTHORIZED", message: "Usuario no autenticado" },
          });
        }
        const result = await TicketAssistantService.chat(
          req.body.messages,
          req.user.id,
          req.user.role,
        );
        res.json({ success: true, data: result });
      } catch (err) {
        next(err);
      }
    },
  ];
}

export default AssistantController;
