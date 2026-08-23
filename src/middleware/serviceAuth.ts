import { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors";
import LabService from "../services/lab.service";

const invalid = () =>
  new ApiError("SERVICE_AUTH_INVALID", "Credenciales de servicio inválidas", 401);

/**
 * Autenticación para agentes de servicio (no personas): el pusher del molino.
 *
 * Clon del patrón de agentAuth.ts. Va en archivo aparte y no se mezcla con la
 * autenticación de usuarios: son dos poblaciones distintas, con credenciales de
 * distinta naturaleza y ciclo de vida.
 *
 * Cabeceras: `x-service-client: <slug>` + `Authorization: Bearer <secreto>`.
 */
export const serviceAuthMiddleware = (requiredScope?: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const slug = req.get("x-service-client")?.trim();
      const authorization = req.get("authorization");
      const secret = authorization?.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : undefined;

      // Se valida la forma antes de tocar la base: un slug o secreto absurdo no
      // debería costar una consulta.
      if (
        !slug ||
        !/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug) ||
        !secret ||
        secret.length < 32 ||
        secret.length > 200
      ) {
        throw invalid();
      }

      const client = await LabService.authenticateClient(slug, secret);

      if (requiredScope && !client.scopes.includes(requiredScope)) {
        throw new ApiError(
          "SERVICE_SCOPE_DENIED",
          "El cliente de servicio no tiene permiso para esta operación",
          403,
          { requiredScope },
        );
      }

      res.locals.serviceClientId = client.id;
      res.locals.serviceClientSlug = client.slug;
      next();
    } catch (error) {
      next(error);
    }
  };
};
