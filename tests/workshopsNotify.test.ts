import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/lib/database", () => ({
  prisma: { user: { findMany: mocks.userFindMany } },
}));

vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.error },
}));

import { notifyDepartmentNewWorkshops } from "../src/services/workshopsImport.service";
import { NotificationsService } from "../src/services/notifications.service";

describe("notifyDepartmentNewWorkshops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifica a los miembros activos del sector, sin email, con link al recurso", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user-1" }, { id: "user-2" }]);
    const createNotification = vi
      .spyOn(NotificationsService, "createNotification")
      .mockResolvedValue(true);

    await notifyDepartmentNewWorkshops(
      "dept-ventas",
      "workshops-imas-ventas",
      "3 workshops disponibles hasta el 20 de ago. Tocá para ver detalles e inscripción.",
    );

    expect(mocks.userFindMany).toHaveBeenCalledWith({
      where: { departmentId: "dept-ventas", isActive: true, deletedAt: null },
      select: { id: true },
    });
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        type: "workshop_available",
        title: "Nuevos workshops para tu sector",
        url: "/resources/workshops-imas-ventas",
        emailEnabled: false,
      }),
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-2" }),
    );
  });

  it("no notifica a nadie si el sector no tiene miembros activos", async () => {
    mocks.userFindMany.mockResolvedValue([]);
    const createNotification = vi
      .spyOn(NotificationsService, "createNotification")
      .mockResolvedValue(true);

    await notifyDepartmentNewWorkshops("dept-vacio", "slug", "excerpt");

    expect(createNotification).not.toHaveBeenCalled();
  });

  it("nunca lanza: un fallo de notificación no debe tumbar el import", async () => {
    mocks.userFindMany.mockRejectedValue(new Error("db caída"));

    await expect(
      notifyDepartmentNewWorkshops("dept-x", "slug-x", "excerpt"),
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalled();
  });
});
