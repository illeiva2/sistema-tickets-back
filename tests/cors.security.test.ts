import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCorsMiddleware } from "../src/middleware/cors";

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  frontendUrl: process.env.FRONTEND_URL,
  frontendUrls: process.env.FRONTEND_URLS,
};

const makeApp = () => {
  const app = express();
  app.use(createCorsMiddleware());
  app.get("/probe", (_req, res) => res.status(200).json({ ok: true }));
  return app;
};

describe("CORS de staging/production", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://tickets-git-staging.example.vercel.app";
    process.env.FRONTEND_URLS = "https://tickets-git-staging.example.vercel.app";
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    restore("NODE_ENV", originalEnv.nodeEnv);
    restore("FRONTEND_URL", originalEnv.frontendUrl);
    restore("FRONTEND_URLS", originalEnv.frontendUrls);
  });

  it("no entrega ACAO a localhost en production", async () => {
    const response = await request(makeApp())
      .get("/probe")
      .set("Origin", "http://localhost:5173");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toContain("Origin");
  });

  it("permite exactamente el preview configurado y marca Vary: Origin", async () => {
    const origin = "https://tickets-git-staging.example.vercel.app";
    const response = await request(makeApp())
      .get("/probe")
      .set("Origin", origin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toContain("Origin");
  });

  it("responde el preflight denegado sin ACAO", async () => {
    const response = await request(makeApp())
      .options("/probe")
      .set("Origin", "https://attacker.example")
      .set("Access-Control-Request-Method", "POST");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toContain("Origin");
  });
});
