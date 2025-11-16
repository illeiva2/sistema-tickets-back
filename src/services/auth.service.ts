import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { prisma } from "../lib/database";
import { config } from "../config";
import { ApiError } from "../lib/errors";
import { logger } from "../lib/logger";

export class AuthService {
  static async login(email: string, password: string) {
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new ApiError("INVALID_CREDENTIALS", "Credenciales inválidas", 401);
    }

    // Verificar si es un usuario de Google OAuth que aún no configuró contraseña
    if (user.googleId && (user as any).mustChangePassword) {
      throw new ApiError(
        "GOOGLE_OAUTH_USER",
        "Este usuario se registró con Google. Por favor, inicia sesión con Google o configura tu contraseña personal primero.",
        401,
      );
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new ApiError("INVALID_CREDENTIALS", "Credenciales inválidas", 401);
    }

    const accessToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        mustChangePassword: (user as any).mustChangePassword ?? false,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as SignOptions,
    );

    const refreshToken = jwt.sign(
      { id: user.id, type: "refresh" },
      config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiresIn } as SignOptions,
    );

    logger.info(`User ${user.email} logged in successfully`);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: (user as any).mustChangePassword ?? false,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  static async register(name: string, email: string, role: string, googleAccessToken: string) {
    try {
      // Verificar que el token de Google sea válido
      const googleUserInfo = await AuthService.verifyGoogleToken(googleAccessToken);
      
      if (!googleUserInfo) {
        throw new ApiError("INVALID_GOOGLE_TOKEN", "Token de Google inválido", 401);
      }

      // Verificar que el email coincida con el token de Google
      if (googleUserInfo.email !== email) {
        throw new ApiError("EMAIL_MISMATCH", "El email no coincide con el token de Google", 400);
      }

      // Verificar dominio autorizado (solo en producción)
      if (config.server.nodeEnv === "production") {
        const allowedDomains = process.env.ALLOWED_EMAIL_DOMAINS?.split(",") || [];
        const userDomain = email.split("@")[1];
        
        if (allowedDomains.length > 0 && !allowedDomains.includes(userDomain)) {
          throw new ApiError(
            "DOMAIN_NOT_AUTHORIZED", 
            "Tu dominio de email no está autorizado para registrarse", 
            403
          );
        }
      }

      // Verificar que el usuario no exista
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new ApiError("USER_ALREADY_EXISTS", "El usuario ya existe", 409);
      }

      // Crear el nuevo usuario
      const newUser = await prisma.user.create({
        data: {
          name,
          email,
          role: role as any,
          googleId: googleUserInfo.sub, // ID único de Google
          mustChangePassword: true, // Debe configurar contraseña
          passwordHash: "", // Contraseña vacía hasta que la configure
        },
      });

      // Generar tokens JWT
      const accessToken = jwt.sign(
        {
          id: newUser.id,
          email: newUser.email,
          role: newUser.role,
          mustChangePassword: true,
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn } as SignOptions,
      );

      const refreshToken = jwt.sign(
        { id: newUser.id, type: "refresh" },
        config.jwt.secret,
        { expiresIn: config.jwt.refreshExpiresIn } as SignOptions,
      );

      logger.info(`New user ${newUser.email} registered successfully via Google OAuth`);

      return {
        accessToken,
        refreshToken,
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
          mustChangePassword: true,
          createdAt: newUser.createdAt,
          updatedAt: newUser.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error("Error during user registration:", error);
      throw new ApiError("REGISTRATION_FAILED", "Error durante el registro", 500);
    }
  }

  static async verifyGoogleToken(accessToken: string) {
    try {
      // Verificar el token de Google usando la API de Google
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`
      );

      if (!response.ok) {
        return null;
      }

      const tokenInfo = await response.json() as {
        aud?: string;
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      
      // Verificar que el token sea para nuestra aplicación
      if (tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID) {
        return null;
      }

      return {
        sub: tokenInfo.sub, // ID único de Google
        email: tokenInfo.email,
        email_verified: tokenInfo.email_verified,
        name: tokenInfo.name,
        picture: tokenInfo.picture,
      };
    } catch (error) {
      logger.error("Error verifying Google token:", error);
      return null;
    }
  }

  static async setupPassword(accessToken: string, newPassword: string) {
    try {
      // Decodificar el token para obtener el ID del usuario
      const decoded = jwt.verify(accessToken, config.jwt.secret) as {
        id: string;
        email: string;
        role: string;
        mustChangePassword: boolean;
      };

      if (!decoded.id) {
        throw new ApiError("INVALID_TOKEN", "Token inválido", 401);
      }

      // Verificar que el usuario debe cambiar la contraseña
      if (!decoded.mustChangePassword) {
        throw new ApiError("PASSWORD_ALREADY_SET", "La contraseña ya está configurada", 400);
      }

      // Buscar el usuario
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
      });

      if (!user) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Hashear la nueva contraseña
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(newPassword, saltRounds);

      // Actualizar el usuario
      const updatedUser = await prisma.user.update({
        where: { id: decoded.id },
        data: {
          passwordHash,
          mustChangePassword: false,
        },
      });

      // Generar nuevos tokens
      const newAccessToken = jwt.sign(
        {
          id: updatedUser.id,
          email: updatedUser.email,
          role: updatedUser.role,
          mustChangePassword: false,
        },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn } as SignOptions,
      );

      const newRefreshToken = jwt.sign(
        { id: updatedUser.id, type: "refresh" },
        config.jwt.secret,
        { expiresIn: config.jwt.refreshExpiresIn } as SignOptions,
      );

      logger.info(`User ${updatedUser.email} password setup completed successfully`);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          name: updatedUser.name,
          role: updatedUser.role,
          mustChangePassword: false,
          createdAt: updatedUser.createdAt,
          updatedAt: updatedUser.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new ApiError("INVALID_TOKEN", "Token inválido o expirado", 401);
      }
      logger.error("Error during password setup:", error);
      throw new ApiError("PASSWORD_SETUP_FAILED", "Error configurando contraseña", 500);
    }
  }

  static async refreshToken(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, config.jwt.secret) as {
        id: string;
        type: string;
      };

      if (decoded.type !== "refresh") {
        throw new ApiError("INVALID_TOKEN", "Token de refresh inválido", 401);
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
      });

      if (!user) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      const newAccessToken = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn } as SignOptions,
      );

      return {
        accessToken: newAccessToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new ApiError("INVALID_TOKEN", "Token de refresh inválido", 401);
      }
      throw error;
    }
  }

  static async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
