import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subUpsert: vi.fn(),
  subDeleteMany: vi.fn(),
  subFindMany: vi.fn(),
  userFindMany: vi.fn(),
  ticketFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
  preferencesFindUnique: vi.fn(),
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock("../src/lib/database", () => ({
  prisma: {
    pushSubscription: {
      upsert: mocks.subUpsert,
      deleteMany: mocks.subDeleteMany,
      findMany: mocks.subFindMany,
    },
    user: { findMany: mocks.userFindMany, findUnique: vi.fn() },
    ticket: { findUnique: mocks.ticketFindUnique },
    notification: { create: mocks.notificationCreate },
    notificationPreferences: { findUnique: mocks.preferencesFindUnique },
  },
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: mocks.sendNotification,
    setVapidDetails: mocks.setVapidDetails,
    generateVAPIDKeys: vi.fn(),
  },
}));

import PushService, { __resetVapidForTests } from "../src/services/push.service";
import { NotificationsService } from "../src/services/notifications.service";
import { subscribeSchema } from "../src/routes/push.routes";

const ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

const subscriptionRow = (id: string, endpoint: string) => ({
  id,
  endpoint,
  p256dh: "p256dh-key",
  auth: "auth-key",
});

describe("Web Push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetVapidForTests();
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
    mocks.subDeleteMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("subscribeSchema acepta el JSON completo del navegador (con expirationTime)", () => {
    // PushSubscription.toJSON() de Chrome/Firefox incluye expirationTime.
    const browserPayload = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      expirationTime: null,
      keys: { p256dh: "clave-p256dh", auth: "clave-auth" },
    };
    expect(subscribeSchema.safeParse(browserPayload).success).toBe(true);

    const withoutExpiration = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: "clave-p256dh", auth: "clave-auth" },
    };
    expect(subscribeSchema.safeParse(withoutExpiration).success).toBe(true);

    const unknownField = { ...withoutExpiration, evil: true };
    expect(subscribeSchema.safeParse(unknownField).success).toBe(false);
  });

  it("getPublicKey devuelve null cuando el canal no está configurado", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect(PushService.getPublicKey()).toBeNull();
  });

  it("subscribe hace upsert por endpoint y reasigna el dispositivo al usuario", async () => {
    mocks.subUpsert.mockResolvedValue({ id: "sub-1" });

    await PushService.subscribe(
      "user-1",
      { endpoint: "https://fcm.example/e1", keys: { p256dh: "a", auth: "b" } },
      "Mozilla/5.0",
    );

    expect(mocks.subUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: "https://fcm.example/e1" },
        create: expect.objectContaining({ userId: "user-1" }),
        update: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("subscribe rechaza con 503 si faltan las claves VAPID", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    await expect(
      PushService.subscribe("user-1", {
        endpoint: "https://fcm.example/e1",
        keys: { p256dh: "a", auth: "b" },
      }),
    ).rejects.toMatchObject({ code: "PUSH_NOT_CONFIGURED" });
  });

  it("unsubscribe borra sólo suscripciones del propio usuario", async () => {
    await PushService.unsubscribe("user-1", "https://fcm.example/e1");
    expect(mocks.subDeleteMany).toHaveBeenCalledWith({
      where: { endpoint: "https://fcm.example/e1", userId: "user-1" },
    });
  });

  it("sendToUser envía a todos los dispositivos y poda los vencidos", async () => {
    mocks.subFindMany.mockResolvedValue([
      subscriptionRow("sub-live", "https://fcm.example/live"),
      subscriptionRow("sub-dead", "https://fcm.example/dead"),
    ]);
    mocks.sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint.endsWith("dead")
        ? Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }))
        : Promise.resolve({}),
    );

    await PushService.sendToUser("user-1", {
      title: "Nuevo ticket #12",
      body: "Impresora rota",
      url: "/tickets/abc",
    });

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(mocks.sendNotification.mock.calls[0][1]);
    expect(payload).toMatchObject({ title: "Nuevo ticket #12", url: "/tickets/abc" });
    expect(mocks.subDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-dead"] } },
    });
  });

  it("sendToUser es inofensivo sin claves configuradas", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    await PushService.sendToUser("user-1", { title: "x", body: "y" });
    expect(mocks.subFindMany).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("createNotification dispara push y respeta emailEnabled=false", async () => {
    mocks.preferencesFindUnique.mockResolvedValue({
      email: true,
      inApp: true,
      ticketAssigned: true,
      statusChanged: true,
      commentAdded: true,
      priorityChanged: true,
    });
    mocks.notificationCreate.mockResolvedValue({ id: "notif-1" });
    mocks.subFindMany.mockResolvedValue([]);

    const sendToUser = vi.spyOn(PushService, "sendToUser").mockResolvedValue();
    const sendEmail = vi
      .spyOn(NotificationsService, "sendEmail")
      .mockResolvedValue(true);

    await NotificationsService.createNotification({
      userId: "agent-1",
      type: "ticket_created",
      title: "Nuevo ticket #7",
      message: 'Ana: "Sin internet"',
      ticketId: "ticket-7",
      emailEnabled: false,
    });

    expect(mocks.notificationCreate).toHaveBeenCalledOnce();
    expect(sendToUser).toHaveBeenCalledWith("agent-1", {
      title: "Nuevo ticket #7",
      body: 'Ana: "Sin internet"',
      url: "/tickets/ticket-7",
    });
    expect(sendEmail).not.toHaveBeenCalled();

    sendToUser.mockRestore();
    sendEmail.mockRestore();
  });

  it("createNotification usa data.url por encima del derivado de ticketId", async () => {
    mocks.preferencesFindUnique.mockResolvedValue({
      email: true,
      inApp: true,
      ticketAssigned: true,
      statusChanged: true,
      commentAdded: true,
      priorityChanged: true,
    });
    mocks.notificationCreate.mockResolvedValue({ id: "notif-2" });
    mocks.subFindMany.mockResolvedValue([]);

    const sendToUser = vi.spyOn(PushService, "sendToUser").mockResolvedValue();

    await NotificationsService.createNotification({
      userId: "user-1",
      type: "workshop_available",
      title: "Nuevos workshops para tu sector",
      message: "3 workshops disponibles.",
      url: "/resources/workshops-imas-ventas",
      emailEnabled: false,
    });

    expect(sendToUser).toHaveBeenCalledWith("user-1", {
      title: "Nuevos workshops para tu sector",
      body: "3 workshops disponibles.",
      url: "/resources/workshops-imas-ventas",
    });

    sendToUser.mockRestore();
  });

  it("notifyTicketCreated avisa al staff activo menos el solicitante, sin email", async () => {
    mocks.ticketFindUnique.mockResolvedValue({
      id: "ticket-9",
      ticketNumber: 9,
      title: "No anda el ERP",
      priority: "HIGH",
      requesterId: "user-requester",
      requester: { id: "user-requester", name: "Aldana Reynoso" },
    });
    mocks.userFindMany.mockResolvedValue([{ id: "agent-1" }, { id: "admin-1" }]);

    const createNotification = vi
      .spyOn(NotificationsService, "createNotification")
      .mockResolvedValue(true);

    await NotificationsService.notifyTicketCreated("ticket-9");

    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: { in: ["AGENT", "ADMIN"] },
          isActive: true,
          id: { not: "user-requester" },
        }),
      }),
    );
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "agent-1",
        type: "ticket_created",
        emailEnabled: false,
        ticketId: "ticket-9",
      }),
    );

    createNotification.mockRestore();
  });
});
