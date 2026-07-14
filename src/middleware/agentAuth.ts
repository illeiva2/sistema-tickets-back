import { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors";
import AgentsService from "../services/agents.service";

const invalid = () =>
  new ApiError("AGENT_AUTH_INVALID", "Credenciales de agente inválidas", 401);

export const agentAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const deviceId = req.get("x-agent-device-id")?.trim();
    const authorization = req.get("authorization");
    const secret = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : undefined;
    if (
      !deviceId ||
      !/^c[^\s-]{8,}$/.test(deviceId) ||
      !secret ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret)
    ) {
      throw invalid();
    }
    const authenticated = await AgentsService.authenticateMachine(deviceId, secret);
    res.locals.agentDeviceId = authenticated.id;
    res.locals.agentSecretHash = authenticated.secretHash;
    next();
  } catch (error) {
    next(error);
  }
};
