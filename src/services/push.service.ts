import webpush from "web-push";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * Canal Web Push: notificaciones nativas en los dispositivos donde el
 * usuario activó el permiso (PWA instalada o navegador). Si las claves
 * VAPID no están configuradas, el canal queda apagado sin romper nada.
 */

let vapidConfigured = false;

const ensureVapid = (): boolean => {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:soporte@grf.com.ar",
    publicKey,
    privateKey,
  );
  vapidConfigured = true;
  return true;
};

// Sólo para tests: permite reevaluar las env en cada caso.
export const __resetVapidForTests = () => {
  vapidConfigured = false;
};

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const EXPIRED_STATUS = new Set([404, 410]);

export class PushService {
  /** Clave pública VAPID para que el front se suscriba; null = canal apagado. */
  static getPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
  }

  static async subscribe(
    userId: string,
    subscription: SubscriptionInput,
    userAgent?: string,
  ) {
    if (!PushService.getPublicKey()) {
      throw new ApiError(
        "PUSH_NOT_CONFIGURED",
        "Las notificaciones push no están habilitadas en el servidor",
        503,
      );
    }

    // El endpoint identifica al dispositivo: si otro usuario inició sesión
    // en el mismo navegador, la suscripción pasa a pertenecerle.
    const saved = await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
      },
      update: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
      },
      select: { id: true },
    });

    logger.info({ userId, subscriptionId: saved.id }, "Push subscription saved");
    return saved;
  }

  static async unsubscribe(userId: string, endpoint: string) {
    const removed = await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });
    logger.info(
      { userId, removed: removed.count },
      "Push subscription removed",
    );
    return { removed: removed.count };
  }

  /**
   * Enviar la notificación a todos los dispositivos suscriptos del usuario.
   * Tolerante: nunca lanza (se usa fire-and-forget desde el flujo de
   * notificaciones); las suscripciones vencidas se eliminan.
   */
  static async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    try {
      if (!ensureVapid()) return;

      const subscriptions = await prisma.pushSubscription.findMany({
        where: { userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      if (subscriptions.length === 0) return;

      const body = JSON.stringify(payload);
      const expired: string[] = [];

      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              body,
              { TTL: 60 * 60 },
            );
          } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            if (statusCode && EXPIRED_STATUS.has(statusCode)) {
              expired.push(subscription.id);
              return;
            }
            logger.warn(
              { userId, subscriptionId: subscription.id, statusCode },
              "Push delivery failed",
            );
          }
        }),
      );

      if (expired.length > 0) {
        await prisma.pushSubscription.deleteMany({
          where: { id: { in: expired } },
        });
        logger.info(
          { userId, pruned: expired.length },
          "Expired push subscriptions pruned",
        );
      }
    } catch (error) {
      logger.error({ err: error, userId }, "Push send failed");
    }
  }
}

export default PushService;
