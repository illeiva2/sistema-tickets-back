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

    if (!user.isActive) {
      throw new ApiError(
        "ACCOUNT_DISABLED",
        "Tu cuenta fue desactivada. Contactá a un administrador.",
        403,
      );
    }

    // Verificar si es un usuario de Google OAuth que aún no configuró contraseña
    if (user.googleId && user.mustChangePassword) {
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

    logger.info(
      { userId: user.id, role: user.role },
      "User logged in successfully",
    );

    return {
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
    };
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

      logger.info(
        { userId: updatedUser.id, role: updatedUser.role },
        "User password setup completed successfully",
      );

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
      logger.error({ err: error }, "Error during password setup:");
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

      if (!user.isActive) {
        throw new ApiError(
          "ACCOUNT_DISABLED",
          "Tu cuenta fue desactivada. Contactá a un administrador.",
          403,
        );
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
      include: {
        department: {
          select: { id: true, name: true, color: true, icon: true },
        },
      },
    });

    if (!user) {
      throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
