import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "crypto";
import { Request, Response, NextFunction, type CookieOptions } from "express";
import passport from "passport";
import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import type { UserRole } from "@prisma/client";
import { oauthConfig } from "../config/oauth";
import { logger } from "../lib/logger";
import { ApiError } from "../lib/errors";
import { config } from "../config";
import { prisma } from "../lib/database";
import { validate } from "../middleware/validation";
import { oauthExchangeSchema } from "../validations/auth";
import { z } from "zod";

export const OAUTH_STATE_COOKIE = "oauth_state";
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const OAUTH_EXCHANGE_CODE_TTL_MS = 5 * 60 * 1000;

const OAUTH_STATE_COOKIE_PATH = "/api/auth/google/callback";
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const stateCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.server.nodeEnv === "production",
  maxAge: OAUTH_STATE_MAX_AGE_MS,
  path: OAUTH_STATE_COOKIE_PATH,
});

const clearStateCookie = (res: Response) => {
  const { maxAge: _maxAge, ...options } = stateCookieOptions();
  res.clearCookie(OAUTH_STATE_COOKIE, options);
};

const getSingleCookie = (cookieHeader: string | undefined, name: string) => {
  if (!cookieHeader) return undefined;

  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    try {
      matches.push(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return undefined;
    }
  }

  return matches.length === 1 ? matches[0] : undefined;
};

const stateSigningSecret = () => {
  const secret = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;

  if (config.server.nodeEnv === "production") {
    throw new ApiError(
      "OAUTH_CONFIG_ERROR",
      "JWT_SECRET no configurado",
      500,
    );
  }

  return oauthConfig.session.secret;
};

const signState = (state: string) =>
  createHmac("sha256", stateSigningSecret())
    .update(`google-oauth-state:v1:${state}`, "utf8")
    .digest("base64url");

const stateMatches = (queryState: unknown, signedCookie: string | undefined) => {
  if (
    typeof queryState !== "string" ||
    !OPAQUE_TOKEN_PATTERN.test(queryState) ||
    !signedCookie
  ) {
    return false;
  }

  const parts = signedCookie.split(".");
  if (
    parts.length !== 2 ||
    !OPAQUE_TOKEN_PATTERN.test(parts[0]) ||
    !OPAQUE_TOKEN_PATTERN.test(parts[1])
  ) {
    return false;
  }

  const cookieState = Buffer.from(parts[0], "utf8");
  const receivedState = Buffer.from(queryState, "utf8");
  const receivedSignature = Buffer.from(parts[1], "utf8");
  const expectedSignature = Buffer.from(signState(parts[0]), "utf8");

  const validSignature =
    receivedSignature.length === expectedSignature.length &&
    timingSafeEqual(receivedSignature, expectedSignature);
  const sameState =
    receivedState.length === cookieState.length &&
    timingSafeEqual(receivedState, cookieState);

  return validSignature && sameState;
};

const hashOpaqueToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

const frontendCallbackUrl = () => {
  const configured =
    process.env.FRONTEND_URL ||
    process.env.FRONTEND_URLS?.split(",")
      .map((value) => value.trim())
      .find(Boolean) ||
    (config.server.nodeEnv === "production" ? "" : "http://localhost:5173");

  if (!configured) {
    throw new ApiError(
      "OAUTH_CONFIG_ERROR",
      "Frontend OAuth no configurado",
      500,
    );
  }

  const redirectUrl = new URL(configured);
  const allowedProtocols =
    config.server.nodeEnv === "production" ? ["https:"] : ["http:", "https:"];
  if (!allowedProtocols.includes(redirectUrl.protocol)) {
    throw new ApiError(
      "OAUTH_CONFIG_ERROR",
      "Frontend OAuth tiene un protocolo inválido",
      500,
    );
  }
  redirectUrl.pathname = "/oauth/callback";
  redirectUrl.search = "";
  redirectUrl.hash = "";
  return redirectUrl;
};

const setNoStore = (res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
};

const redirectWithOAuthError = (res: Response, error: string) => {
  const redirectUrl = frontendCallbackUrl();
  redirectUrl.searchParams.set("error", error);
  setNoStore(res);
  return res.status(302).redirect(redirectUrl.toString());
};

type TokenUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const issueTokens = (user: TokenUser) => {
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as SignOptions,
  );
  const refreshToken = jwt.sign(
    { id: user.id, type: "refresh" },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn } as SignOptions,
  );

  return { accessToken, refreshToken };
};

export class OAuthController {
  // Iniciar autenticación con Google
  static initiateGoogleAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const state = randomBytes(32).toString("base64url");
      const signedState = `${state}.${signState(state)}`;
      res.cookie(OAUTH_STATE_COOKIE, signedState, stateCookieOptions());

      passport.authenticate("google", {
        scope: oauthConfig.google.scope,
        session: false,
        state,
      })(req, res, next);
    } catch (error) {
      next(error);
    }
  };

  // Callback de Google OAuth
  static googleCallback = (req: Request, res: Response, next: NextFunction) => {
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader || "missing";
    const logContext = { requestId };

    logger.info(logContext, "Google OAuth callback initiated");

    const cookieState = getSingleCookie(
      req.headers.cookie,
      OAUTH_STATE_COOKIE,
    );
    clearStateCookie(res);

    if (!stateMatches(req.query.state, cookieState)) {
      logger.warn(
        { ...logContext, outcome: "invalid_state" },
        "Google OAuth callback rejected",
      );
      try {
        return redirectWithOAuthError(res, "oauth_state_invalid");
      } catch (error) {
        return next(error);
      }
    }

    passport.authenticate(
      "google",
      { session: false },
      async (err: any, user: any) => {
        const outcome = err ? "error" : user ? "user_received" : "no_user";
        logger.info(
          { ...logContext, outcome },
          "Google OAuth passport callback completed",
        );

        if (err || !user) {
          if (err) {
            logger.error(
              {
                ...logContext,
                errorType: err instanceof Error ? err.name : typeof err,
              },
              "Google OAuth authentication failed",
            );
          } else {
            logger.warn(logContext, "Google OAuth returned no user");
          }

          const providerErrorCode = (err as { code?: unknown } | null)?.code;
          const errorCode =
            providerErrorCode === "domain_not_allowed"
              ? "domain_not_allowed"
              : providerErrorCode === "it_access_required"
                ? "it_access_required"
              : providerErrorCode === "account_disabled"
                ? "account_disabled"
                : "auth_failed";
          try {
            return redirectWithOAuthError(res, errorCode);
          } catch (error) {
            return next(error);
          }
        }

        try {
          const userContext = {
            ...logContext,
            userId: user.id,
            role: user.role,
          };
          if (user.isActive === false || user.deletedAt) {
            logger.warn(
              { ...userContext, outcome: "account_disabled" },
              "Google OAuth authentication rejected",
            );
            return redirectWithOAuthError(res, "account_disabled");
          }

          const exchangeCode = randomBytes(32).toString("base64url");
          await prisma.oAuthExchangeCode.create({
            data: {
              codeHash: hashOpaqueToken(exchangeCode),
              userId: user.id,
              expiresAt: new Date(Date.now() + OAUTH_EXCHANGE_CODE_TTL_MS),
            },
          });

          const redirectUrl = frontendCallbackUrl();
          redirectUrl.searchParams.set("code", exchangeCode);
          setNoStore(res);

          logger.info(
            {
              ...userContext,
              redirectOrigin: redirectUrl.origin,
              redirectPath: redirectUrl.pathname,
            },
            "Google OAuth redirect prepared",
          );
          logger.info(userContext, "Google OAuth authentication succeeded");
          
          // Asegurar que la respuesta se envíe correctamente
          res.status(302).redirect(redirectUrl.toString());
        } catch (error) {
          logger.error(
            {
              ...logContext,
              errorType: error instanceof Error ? error.name : typeof error,
            },
            "Google OAuth exchange code creation failed",
          );
          return next(
            new ApiError(
              "OAUTH_EXCHANGE_CODE_FAILED",
              "Error completando autenticación OAuth",
              500,
            ),
          );
        }
      },
    )(req, res, next);
  };

  static exchangeGoogleCode = [
    validate(z.object({ body: oauthExchangeSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      setNoStore(res);

      try {
        const codeHash = hashOpaqueToken(req.body.code);
        const now = new Date();
        const consumed = await prisma.oAuthExchangeCode.updateMany({
          where: {
            codeHash,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { consumedAt: now },
        });

        if (consumed.count !== 1) {
          throw new ApiError(
            "INVALID_OAUTH_CODE",
            "Código OAuth inválido o expirado",
            400,
          );
        }

        const storedCode = await prisma.oAuthExchangeCode.findUnique({
          where: { codeHash },
          include: { user: true },
        });

        if (!storedCode) {
          throw new ApiError(
            "INVALID_OAUTH_CODE",
            "Código OAuth inválido o expirado",
            400,
          );
        }

        const user = storedCode.user;
        if (!user.isActive || user.deletedAt) {
          throw new ApiError(
            "ACCOUNT_DISABLED",
            "Tu cuenta fue desactivada. Contactá a un administrador.",
            403,
          );
        }

        const { accessToken, refreshToken } = issueTokens(user);
        logger.info(
          { userId: user.id, role: user.role },
          "Google OAuth exchange code consumed",
        );

        return res.json({
          success: true,
          data: {
            accessToken,
            refreshToken,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              mustChangePassword: user.mustChangePassword ?? false,
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          },
        });
      } catch (error) {
        return next(error);
      }
    },
  ];

  // Verificar token de acceso
  static verifyToken = (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new ApiError("NO_TOKEN", "Token de acceso no proporcionado", 401);
      }

      const token = authHeader.substring(7);
      const decoded = jwt.verify(
        token,
        oauthConfig.jwt.secret || config.jwt.secret,
      ) as JwtPayload & {
        userId?: string;
        email?: string;
        role?: UserRole;
      };

      if (!decoded.userId || !decoded.email || !decoded.role) {
        throw new ApiError("INVALID_TOKEN", "Token inválido", 401);
      }

      req.user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      };

      next();
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return next(
          new ApiError("INVALID_TOKEN", "Token inválido o expirado", 401),
        );
      }

      logger.error({ err: error }, "Token verification error:");
      return next(
        new ApiError(
          "TOKEN_VERIFICATION_FAILED",
          "Error verificando token",
          500,
        ),
      );
    }
  };

  // Refrescar token
  static refreshToken = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        throw new ApiError(
          "NO_REFRESH_TOKEN",
          "Token de refresco no proporcionado",
          400,
        );
      }

      const decoded = jwt.verify(
        refreshToken,
        oauthConfig.jwt.secret,
      ) as JwtPayload & { userId?: string; type?: string };

      if (!decoded.userId || decoded.type !== "refresh") {
        throw new ApiError(
          "INVALID_REFRESH_TOKEN",
          "Token de refresco inválido",
          401,
        );
      }

      // Obtener información del usuario
      const user = await (
        await import("../lib/database")
      ).prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, email: true, role: true },
      });

      if (!user) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Generar nuevo access token
      // @ts-ignore - JWT sign type compatibility issue
      const newAccessToken = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          role: user.role,
        },
        (oauthConfig.jwt.secret || config.jwt.secret || "fallback-secret") as string,
        { expiresIn: oauthConfig.jwt.expiresIn || "15m" },
      );

      res.json({
        success: true,
        data: {
          accessToken: newAccessToken,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
          },
        },
      });
    } catch (error) {
      if (error instanceof ApiError) {
        return next(error);
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return next(
          new ApiError(
            "INVALID_REFRESH_TOKEN",
            "Token de refresco inválido o expirado",
            401,
          ),
        );
      }

      logger.error({ err: error }, "Token refresh error:");
      return next(
        new ApiError("TOKEN_REFRESH_FAILED", "Error refrescando token", 500),
      );
    }
  };

  // Logout
  static logout = (req: Request, res: Response) => {
    // En JWT, el logout se maneja en el frontend eliminando los tokens
    // Aquí podríamos implementar una blacklist de tokens si es necesario
    res.json({
      success: true,
      message: "Logout exitoso",
    });
  };
}

export default OAuthController;
