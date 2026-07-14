import { NextFunction, Response } from "express";
import { z } from "zod";
import { ApiError } from "../lib/errors";
import { AuthenticatedRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import AgentsService from "../services/agents.service";
import {
  agentDeviceFiltersSchema,
  agentDeviceIdParamsSchema,
  agentDeviceTransitionSchema,
  createEnrollmentTokenSchema,
  enrollmentTokenFiltersSchema,
  enrollmentTokenIdParamsSchema,
  linkAgentAssetSchema,
  machineEnrollSchema,
  machineHeartbeatSchema,
  metricFiltersSchema,
  registerAgentAssetSchema,
  remoteSessionIdParamsSchema,
  snapshotFiltersSchema,
  startRemoteSessionSchema,
} from "../validations/agents";

const user = (req: AuthenticatedRequest) => {
  if (!req.user) throw new ApiError("UNAUTHORIZED", "Usuario no autenticado", 401);
  return req.user;
};

const handle = (
  work: (req: AuthenticatedRequest, res: Response) => Promise<unknown>,
  key?: string,
  status = 200,
) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    user(req);
    const result = await work(req, res);
    res.status(status).json({ success: true, data: key ? { [key]: result } : result });
  } catch (error) {
    next(error);
  }
};

export class AgentsController {
  static lookups = [handle(async () => AgentsService.lookups())];

  static listTokens = [
    validate(z.object({ query: enrollmentTokenFiltersSchema })),
    handle(async (req) => AgentsService.listEnrollmentTokens(req.query as any)),
  ];

  static createToken = [
    validate(z.object({ body: createEnrollmentTokenSchema })),
    handle(
      async (req) => AgentsService.createEnrollmentToken(req.body, user(req).id),
      undefined,
      201,
    ),
  ];

  static revokeToken = [
    validate(
      z.object({
        params: enrollmentTokenIdParamsSchema,
        body: z.object({}).strict(),
      }),
    ),
    handle(async (req) => AgentsService.revokeEnrollmentToken(req.params.id, user(req).id)),
  ];

  static listDevices = [
    validate(z.object({ query: agentDeviceFiltersSchema })),
    handle(async (req) => AgentsService.listDevices(req.query as any)),
  ];

  static getDevice = [
    validate(z.object({ params: agentDeviceIdParamsSchema })),
    handle(async (req) => AgentsService.getDevice(req.params.id), "device"),
  ];

  static linkAsset = [
    validate(z.object({ params: agentDeviceIdParamsSchema, body: linkAgentAssetSchema })),
    handle(
      async (req) => AgentsService.linkAsset(req.params.id, req.body, user(req).id),
      "device",
    ),
  ];

  static registerAsset = [
    validate(
      z.object({
        params: agentDeviceIdParamsSchema,
        body: registerAgentAssetSchema,
      }),
    ),
    handle(
      async (req) => {
        const actor = user(req);
        return AgentsService.registerAsset(
          req.params.id,
          req.body,
          actor.id,
          actor.role,
        );
      },
      undefined,
      201,
    ),
  ];

  private static transition(action: "activateDevice" | "revokeDevice") {
    return [
      validate(
        z.object({ params: agentDeviceIdParamsSchema, body: agentDeviceTransitionSchema }),
      ),
      handle(
        async (req) =>
          AgentsService[action](req.params.id, req.body, user(req).id),
        "device",
      ),
    ];
  }

  static activateDevice = AgentsController.transition("activateDevice");
  static revokeDevice = AgentsController.transition("revokeDevice");

  static snapshots = [
    validate(z.object({ params: agentDeviceIdParamsSchema, query: snapshotFiltersSchema })),
    handle(async (req) => AgentsService.listSnapshots(req.params.id, req.query as any)),
  ];

  static metrics = [
    validate(z.object({ params: agentDeviceIdParamsSchema, query: metricFiltersSchema })),
    handle(async (req) => AgentsService.listMetrics(req.params.id, req.query as any)),
  ];

  static startSession = [
    validate(z.object({ params: agentDeviceIdParamsSchema, body: startRemoteSessionSchema })),
    handle(async (req) =>
      AgentsService.startRemoteSession(
        req.params.id,
        req.body,
        user(req).id,
        req.ip || null,
      )),
  ];

  static closeSession = [
    validate(
      z.object({
        params: remoteSessionIdParamsSchema,
        body: z.object({}).strict(),
      }),
    ),
    handle(
      async (req) => AgentsService.closeRemoteSession(req.params.id, user(req).id),
      "session",
    ),
  ];
}

export class MachineAgentController {
  static enroll = [
    validate(z.object({ body: machineEnrollSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const result = await AgentsService.enrollMachine(req.body);
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];

  static heartbeat = [
    validate(z.object({ body: machineHeartbeatSchema })),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const result = await AgentsService.recordHeartbeat(
          res.locals.agentDeviceId,
          res.locals.agentSecretHash,
          req.body,
        );
        res.json({ success: true, data: result });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export default AgentsController;
