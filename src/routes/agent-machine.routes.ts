import { Router } from "express";
import rateLimit from "express-rate-limit";
import { MachineAgentController } from "../controllers/agents.controller";
import { agentAuthMiddleware } from "../middleware/agentAuth";

const router = Router();
export const AGENT_ENROLL_RATE_LIMIT = 120;
const limited = {
  success: false,
  error: {
    code: "AGENT_RATE_LIMITED",
    message: "Demasiadas solicitudes del agente; intente nuevamente más tarde",
  },
};

const enrollLimiter = rateLimit({
  windowMs: 15 * 60_000,
  // Permite desplegar manualmente el agente en toda la sede detrás de una
  // misma NAT durante una ventana de mantenimiento.
  max: AGENT_ENROLL_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: limited,
});

// Techo por IP deliberadamente alto: decenas de equipos pueden compartir la
// misma NAT. El segundo limiter, aplicado después de autenticar, aísla floods
// por deviceId sin bloquear a toda la sede.
const heartbeatIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 3_000,
  standardHeaders: true,
  legacyHeaders: false,
  message: limited,
});

const heartbeatDeviceLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => res.locals.agentDeviceId,
  message: limited,
});

router.post("/enroll", enrollLimiter, ...MachineAgentController.enroll);
router.post(
  "/heartbeat",
  heartbeatIpLimiter,
  agentAuthMiddleware,
  heartbeatDeviceLimiter,
  ...MachineAgentController.heartbeat,
);

export default router;
