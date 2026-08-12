import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { ApiError } from "../lib/errors";
import PushService from "../services/push.service";

const router = Router();

const requireUser = (req: AuthenticatedRequest) => {
  if (!req.user) throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  return req.user;
};

export const subscribeSchema = z
  .object({
    endpoint: z.string().url().max(1000),
    // PushSubscription.toJSON() incluye expirationTime (null en la práctica);
    // se acepta y descarta para no rechazar la suscripción del navegador.
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(300),
        auth: z.string().min(1).max(300),
      })
      .strict(),
  })
  .strict();

const unsubscribeSchema = z
  .object({ endpoint: z.string().url().max(1000) })
  .strict();

// Clave pública VAPID; publicKey null significa canal deshabilitado y el
// front oculta el botón de activación.
router.get(
  "/public-key",
  authMiddleware,
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      requireUser(req);
      res.json({
        success: true,
        data: { publicKey: PushService.getPublicKey() },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/subscribe",
  authMiddleware,
  validate(z.object({ body: subscribeSchema })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      await PushService.subscribe(
        user.id,
        req.body,
        req.headers["user-agent"],
      );
      res.status(201).json({ success: true, data: { subscribed: true } });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/unsubscribe",
  authMiddleware,
  validate(z.object({ body: unsubscribeSchema })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const result = await PushService.unsubscribe(user.id, req.body.endpoint);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
