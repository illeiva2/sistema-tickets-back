import { vi, describe, it, beforeEach, expect } from "vitest";

vi.mock("../src/lib/database", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { prisma: mockDeep() };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test" }),
      verify: vi.fn().mockResolvedValue(true),
    }),
  },
}));

import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/database";
import type { DeepMockProxy } from "vitest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { signAccessToken } from "./helpers";

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const makeProject = (overrides: Partial<any> = {}) => ({
  id: "p-1",
  slug: "portal-de-granos",
  title: "Portal de granos",
  description: "## Portal\n\nDescripción extensa.",
  excerpt: "Resumen",
  status: "IN_PROGRESS",
  progressPercent: 20,
  startedAt: new Date(),
  expectedEndAt: null,
  completedAt: null,
  isPublished: true,
  isPinned: false,
  leadId: "admin-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  lead: { id: "admin-1", name: "Admin", email: "admin@x.com" },
  team: [],
  ...overrides,
});

describe("GET /api/projects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER solo ve publicados", async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([makeProject()] as any);
    prismaMock.project.count.mockResolvedValueOnce(1);

    const token = signAccessToken({ role: "USER" });
    await request(app).get("/api/projects").set(auth(token));

    const call = prismaMock.project.findMany.mock.calls[0][0] as any;
    expect(call.where.isPublished).toBe(true);
  });

  it("ADMIN con includeDrafts=true puede ver borradores", async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([] as any);
    prismaMock.project.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "ADMIN" });
    await request(app)
      .get("/api/projects?includeDrafts=true")
      .set(auth(token));

    const call = prismaMock.project.findMany.mock.calls[0][0] as any;
    expect(call.where.isPublished).toBeUndefined();
  });

  it("filtra por status", async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([] as any);
    prismaMock.project.count.mockResolvedValueOnce(0);

    const token = signAccessToken({ role: "USER" });
    await request(app)
      .get("/api/projects?status=COMPLETED")
      .set(auth(token));

    const call = prismaMock.project.findMany.mock.calls[0][0] as any;
    expect(call.where.status).toBe("COMPLETED");
  });

  it("rechaza status inválido", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/projects?status=NOPE")
      .set(auth(token));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/in-progress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Devuelve solo IN_PROGRESS publicados, máx 5", async () => {
    prismaMock.project.findMany.mockResolvedValueOnce([makeProject()] as any);

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/projects/in-progress")
      .set(auth(token));

    expect(res.status).toBe(200);
    const call = prismaMock.project.findMany.mock.calls[0][0] as any;
    expect(call.where.status).toBe("IN_PROGRESS");
    expect(call.where.isPublished).toBe(true);
    expect(call.take).toBe(5);
  });
});

describe("GET /api/projects/:idOrSlug", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER ve un proyecto publicado", async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(
      makeProject({ isPublished: true }) as any,
    );

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/projects/portal-de-granos")
      .set(auth(token));

    expect(res.status).toBe(200);
  });

  it("USER NO ve un proyecto draft (404 silencioso)", async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(
      makeProject({ isPublished: false }) as any,
    );

    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .get("/api/projects/portal-de-granos")
      .set(auth(token));

    expect(res.status).toBe(404);
  });

  it("ADMIN ve drafts", async () => {
    prismaMock.project.findFirst.mockResolvedValueOnce(
      makeProject({ isPublished: false }) as any,
    );

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .get("/api/projects/portal-de-granos")
      .set(auth(token));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/projects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("USER no puede crear", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({ title: "Nuevo", description: "x" });
    expect(res.status).toBe(403);
  });

  it("AGENT puede crear (se auto-asigna como lead)", async () => {
    const agentId = "cmhagent00000000000000001";
    prismaMock.project.findUnique.mockResolvedValueOnce(null);
    prismaMock.project.create.mockResolvedValueOnce(
      makeProject({ leadId: agentId }) as any,
    );

    const token = signAccessToken({ id: agentId, role: "AGENT" });
    const res = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({
        title: "Mi nuevo proyecto",
        description: "una descripción",
        status: "PLANNED",
      });

    expect(res.status).toBe(201);
    const call = prismaMock.project.create.mock.calls[0][0] as any;
    expect(call.data.leadId).toBe(agentId);
  });

  it("AGENT no puede asignar a otro lead", async () => {
    const agentId = "cmhagent00000000000000001";
    const otherLeadId = "cmhother00000000000000001";

    const token = signAccessToken({ id: agentId, role: "AGENT" });
    const res = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({
        title: "Proyecto",
        description: "x",
        leadId: otherLeadId,
      });

    expect(res.status).toBe(403);
  });

  it("ADMIN puede asignar otro lead", async () => {
    const adminId = "cmhadmin0000000000000000a";
    const otherLeadId = "cmhother00000000000000001";

    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: otherLeadId,
      role: "AGENT",
      isActive: true,
    } as any);
    prismaMock.project.findUnique.mockResolvedValueOnce(null);
    prismaMock.project.create.mockResolvedValueOnce(
      makeProject({ leadId: otherLeadId }) as any,
    );

    const token = signAccessToken({ id: adminId, role: "ADMIN" });
    const res = await request(app)
      .post("/api/projects")
      .set(auth(token))
      .send({
        title: "Proyecto",
        description: "x",
        leadId: otherLeadId,
      });

    expect(res.status).toBe(201);
  });
});

describe("PATCH /api/projects/:id — permisos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AGENT que es lead puede editar", async () => {
    const agentId = "cmhagent00000000000000001";
    prismaMock.project.findUnique.mockResolvedValueOnce(
      makeProject({ leadId: agentId, team: [] }) as any,
    );
    prismaMock.project.update.mockResolvedValueOnce(
      makeProject({ leadId: agentId, progressPercent: 50 }) as any,
    );

    const token = signAccessToken({ id: agentId, role: "AGENT" });
    const res = await request(app)
      .patch("/api/projects/p-1")
      .set(auth(token))
      .send({ progressPercent: 50 });

    expect(res.status).toBe(200);
  });

  it("AGENT en el team puede editar", async () => {
    const agentId = "cmhagent00000000000000001";
    prismaMock.project.findUnique.mockResolvedValueOnce(
      makeProject({
        leadId: "cmhother00000000000000001",
        team: [{ id: agentId }],
      }) as any,
    );
    prismaMock.project.update.mockResolvedValueOnce(makeProject() as any);

    const token = signAccessToken({ id: agentId, role: "AGENT" });
    const res = await request(app)
      .patch("/api/projects/p-1")
      .set(auth(token))
      .send({ progressPercent: 50 });

    expect(res.status).toBe(200);
  });

  it("AGENT que no es lead ni team NO puede editar", async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(
      makeProject({
        leadId: "cmhother00000000000000001",
        team: [],
      }) as any,
    );

    const token = signAccessToken({ id: "cmhagent00000000000000002", role: "AGENT" });
    const res = await request(app)
      .patch("/api/projects/p-1")
      .set(auth(token))
      .send({ progressPercent: 50 });

    expect(res.status).toBe(403);
  });

  it("ADMIN siempre puede editar cualquier proyecto", async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(
      makeProject({
        leadId: "cmhother00000000000000001",
        team: [],
      }) as any,
    );
    prismaMock.project.update.mockResolvedValueOnce(makeProject() as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .patch("/api/projects/p-1")
      .set(auth(token))
      .send({ status: "COMPLETED" });

    expect(res.status).toBe(200);
  });

  it("USER no puede editar", async () => {
    const token = signAccessToken({ role: "USER" });
    const res = await request(app)
      .patch("/api/projects/p-1")
      .set(auth(token))
      .send({ progressPercent: 100 });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/projects/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN elimina", async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(makeProject() as any);
    prismaMock.project.delete.mockResolvedValueOnce({} as any);

    const token = signAccessToken({ role: "ADMIN" });
    const res = await request(app)
      .delete("/api/projects/p-1")
      .set(auth(token));

    expect(res.status).toBe(200);
  });

  it("AGENT no puede eliminar (aunque sea lead)", async () => {
    const token = signAccessToken({ role: "AGENT" });
    const res = await request(app)
      .delete("/api/projects/p-1")
      .set(auth(token));

    expect(res.status).toBe(403);
  });
});
