import { Request, Response, NextFunction } from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import { oauthConfig } from "../config/oauth";
import { logger } from "../lib/logger";
import { ApiError } from "../lib/errors";
import { config } from "../config";

export class OAuthController {
  // Iniciar autenticación con Google
  static initiateGoogleAuth = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    passport.authenticate("google", { scope: oauthConfig.google.scope })(
      req,
      res,
      next,
    );
  };

  // Callback de Google OAuth
  static googleCallback = (req: Request, res: Response, next: NextFunction) => {
    logger.info("Google OAuth callback initiated");
    logger.info(`Query params: ${JSON.stringify(req.query)}`);

    passport.authenticate(
      "google",
      { session: false },
      (err: any, user: any, info: any) => {
        logger.info("Passport authenticate callback executed");
        logger.info(err ? err : "No Error", "Error:");
        logger.info(`User: ${JSON.stringify(user)}`);
        logger.info(`Info: ${JSON.stringify(info)}`);

        if (err || !user) {
          if (err) {
            logger.error(err, "Google OAuth error:");
          } else {
            logger.error("No user returned from Google OAuth");
          }

          const redirectUrl = new URL(
            process.env.FRONTEND_URL || (process.env.NODE_ENV === "production" 
              ? process.env.FRONTEND_URLS?.split(',')[0] || "http://localhost:5173"
              : "http://localhost:5173"),
          );
          
          let errorMsg = "auth_failed";
          if (err && err.message) {
            if (err.message.includes("Acceso denegado")) {
              errorMsg = "domain_not_allowed";
            } else {
              errorMsg = err.message;
            }
          }
          
          redirectUrl.searchParams.set("error", errorMsg);
          return res.status(302).redirect(redirectUrl.toString());
        }

        try {
          logger.info(`Generando JWT tokens para usuario: ${user.email}`);
          
          // Generar JWT tokens
          // @ts-ignore - JWT sign type compatibility issue
          const accessToken = jwt.sign(
            {
              userId: user.id,
              email: user.email,
              role: user.role,
            },
            (oauthConfig.jwt.secret || config.jwt.secret || "fallback-secret") as string,
            { expiresIn: oauthConfig.jwt.expiresIn || "15m" },
          );

          // @ts-ignore - JWT sign type compatibility issue
          const refreshToken = jwt.sign(
            {
              userId: user.id,
              type: "refresh",
            },
            (oauthConfig.jwt.secret || config.jwt.secret || "fallback-secret") as string,
            { expiresIn: oauthConfig.jwt.refreshExpiresIn || "7d" },
          );

          logger.info("JWT tokens generados exitosamente");

          // Redirigir al frontend con tokens
          const redirectUrl = new URL(
            process.env.FRONTEND_URL || (process.env.NODE_ENV === "production" 
              ? process.env.FRONTEND_URLS?.split(',')[0] || "http://localhost:5173"
              : "http://localhost:5173"),
          );
          
          redirectUrl.pathname = '/oauth/callback';
          
          redirectUrl.searchParams.set("accessToken", accessToken);
          redirectUrl.searchParams.set("refreshToken", refreshToken);
          redirectUrl.searchParams.set(
            "user",
            JSON.stringify({
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
            }),
          );

          logger.info(`Redirigiendo a: ${redirectUrl.toString()}`);
          logger.info(`User ${user.email} authenticated via Google OAuth`);
          
          // Asegurar que la respuesta se envíe correctamente
          res.status(302).redirect(redirectUrl.toString());
        } catch (error) {
          logger.error({ err: error }, "Error generating JWT tokens:");
          return next(
            new ApiError(
              "TOKEN_GENERATION_FAILED",
              "Error generando tokens de acceso",
              500,
            ),
          );
        }
      },
    )(req, res, next);
  };

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
      ) as any;

      if (!decoded.userId) {
        throw new ApiError("INVALID_TOKEN", "Token inválido", 401);
      }

      // Agregar información del usuario al request
      (req as any).user = {
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

      const decoded = jwt.verify(refreshToken, oauthConfig.jwt.secret) as any;

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
