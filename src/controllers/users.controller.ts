import { Response, NextFunction } from "express";
import { prisma } from "../lib/database";
import { AuthenticatedRequest } from "../middleware/auth";
import { ApiError } from "../lib/errors";
import { UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";

// Esquemas de validación
const createUserSchema = z.object({
  name: z.string().min(2, "El nombre debe tener al menos 2 caracteres"),
  email: z.string().email("Email inválido"),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
  role: z.enum(["USER", "AGENT", "ADMIN"]),
});

const updateUserSchema = z.object({
  name: z
    .string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .optional(),
  email: z.string().email("Email inválido").optional(),
  role: z.enum(["USER", "AGENT", "ADMIN"]).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Contraseña actual requerida"),
  newPassword: z
    .string()
    .min(6, "La nueva contraseña debe tener al menos 6 caracteres"),
});

export class UsersController {
  // Listar todos los usuarios (solo ADMIN)
  static listUsers = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { user } = req;
      if (user?.role !== "ADMIN") {
        throw new ApiError(
          "FORBIDDEN",
          "Solo los administradores pueden ver todos los usuarios",
          403,
        );
      }

      const users = await prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              requestedTickets: true,
              assignedTickets: true,
            },
          },
        },
        orderBy: { name: "asc" },
      });

      res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  };

  // Listar solo agentes (para asignación de tickets)
  static listAgents = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const agents = await prisma.user.findMany({
        where: { role: "AGENT" as any },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      });
      res.json({ success: true, data: agents });
    } catch (err) {
      next(err);
    }
  };

  // Obtener usuario por ID
  static getUserById = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { user } = req;

      // Solo ADMIN puede ver cualquier usuario, otros solo pueden verse a sí mismos
      if (user?.role !== "ADMIN" && user?.id !== id) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para ver este usuario",
          403,
        );
      }

      const userData = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              requestedTickets: true,
              assignedTickets: true,
            },
          },
        },
      });

      if (!userData) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      res.json({ success: true, data: userData });
    } catch (err) {
      next(err);
    }
  };

  // Crear nuevo usuario (solo ADMIN)
  static createUser = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { user } = req;
      if (user?.role !== "ADMIN") {
        throw new ApiError(
          "FORBIDDEN",
          "Solo los administradores pueden crear usuarios",
          403,
        );
      }

      const validatedData = createUserSchema.parse(req.body);

      // Verificar si el email ya existe
      const existingUser = await prisma.user.findUnique({
        where: { email: validatedData.email },
      });

      if (existingUser) {
        throw new ApiError(
          "EMAIL_ALREADY_EXISTS",
          "El email ya está registrado",
          400,
        );
      }

      // Hash de la contraseña
      const passwordHash = await bcrypt.hash(validatedData.password, 12);

      const newUser = await prisma.user.create({
        data: {
          name: validatedData.name,
          email: validatedData.email,
          passwordHash,
          role: validatedData.role as UserRole,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.status(201).json({ success: true, data: newUser });
    } catch (err) {
      next(err);
    }
  };

  // Actualizar usuario
  static updateUser = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { user } = req;
      const validatedData = updateUserSchema.parse(req.body);

      // Solo ADMIN puede actualizar cualquier usuario, otros solo pueden actualizarse a sí mismos
      if (user?.role !== "ADMIN" && user?.id !== id) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para actualizar este usuario",
          403,
        );
      }

      // Si no es ADMIN, no puede cambiar el rol
      if (user?.role !== "ADMIN" && validatedData.role) {
        throw new ApiError("FORBIDDEN", "No puedes cambiar tu propio rol", 403);
      }

      // Verificar si el usuario existe
      const existingUser = await prisma.user.findUnique({ where: { id } });
      if (!existingUser) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Si se está cambiando el email, verificar que no exista
      if (validatedData.email && validatedData.email !== existingUser.email) {
        const emailExists = await prisma.user.findUnique({
          where: { email: validatedData.email },
        });
        if (emailExists) {
          throw new ApiError(
            "EMAIL_ALREADY_EXISTS",
            "El email ya está registrado",
            400,
          );
        }
      }

      const updatedUser = await prisma.user.update({
        where: { id },
        data: validatedData,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json({ success: true, data: updatedUser });
    } catch (err) {
      next(err);
    }
  };

  // Cambiar contraseña
  static changePassword = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { currentPassword, newPassword } = req.body;
      const { user } = req;

      // Solo el usuario puede cambiar su propia contraseña
      if (user?.id !== id) {
        throw new ApiError(
          "FORBIDDEN",
          "Solo puedes cambiar tu propia contraseña",
          403,
        );
      }

      const dbUser = await prisma.user.findUnique({ where: { id } });
      if (!dbUser) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Verificar contraseña actual
      const isValidPassword = await bcrypt.compare(
        currentPassword,
        dbUser.passwordHash,
      );
      if (!isValidPassword) {
        throw new ApiError("INVALID_PASSWORD", "Contraseña actual incorrecta", 400);
      }

      // Hashear nueva contraseña
      const saltRounds = 12;
      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

      // Actualizar contraseña
      await prisma.user.update({
        where: { id },
        data: { passwordHash: newPasswordHash },
      });

      res.json({ success: true, message: "Contraseña actualizada correctamente" });
    } catch (err) {
      next(err);
    }
  };

  // Blanquear contraseña de un usuario (solo ADMIN)
  static resetPassword = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { user } = req;

      // Solo ADMIN puede blanquear contraseñas
      if (user?.role !== "ADMIN") {
        throw new ApiError(
          "FORBIDDEN",
          "Solo los administradores pueden blanquear contraseñas",
          403,
        );
      }

      // No permitir blanquear la propia contraseña
      if (user?.id === id) {
        throw new ApiError(
          "FORBIDDEN",
          "No puedes blanquear tu propia contraseña",
          400,
        );
      }

      const dbUser = await prisma.user.findUnique({ where: { id } });
      if (!dbUser) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Blanquear contraseña (establecer mustChangePassword = true)
      await prisma.user.update({
        where: { id },
        data: { 
          mustChangePassword: true,
          passwordHash: "", // Contraseña vacía
        },
      });

      res.json({ 
        success: true, 
        message: "Contraseña blanqueada correctamente. El usuario deberá configurar una nueva contraseña en su próximo inicio de sesión." 
      });
    } catch (err) {
      next(err);
    }
  };

  // Eliminar usuario (solo ADMIN)
  static deleteUser = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { user } = req;

      if (user?.role !== "ADMIN") {
        throw new ApiError(
          "FORBIDDEN",
          "Solo los administradores pueden eliminar usuarios",
          403,
        );
      }

      // No permitir eliminar el propio usuario
      if (user.id === id) {
        throw new ApiError(
          "FORBIDDEN",
          "No puedes eliminar tu propia cuenta",
          400,
        );
      }

      // Verificar si el usuario existe
      const existingUser = await prisma.user.findUnique({ where: { id } });
      if (!existingUser) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Verificar si el usuario tiene tickets asignados o creados
      const userTickets = await prisma.ticket.findMany({
        where: {
          OR: [{ requesterId: id }, { assigneeId: id }],
        },
      });

      if (userTickets.length > 0) {
        throw new ApiError(
          "USER_HAS_TICKETS",
          "No se puede eliminar un usuario con tickets asociados",
          400,
        );
      }

      await prisma.user.delete({ where: { id } });

      res.json({ success: true, message: "Usuario eliminado correctamente" });
    } catch (err) {
      next(err);
    }
  };

  // Obtener estadísticas del usuario
  static getUserStats = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { id } = req.params;
      const { user } = req;

      // Solo ADMIN puede ver estadísticas de cualquier usuario, otros solo pueden verse a sí mismos
      if (user?.role !== "ADMIN" && user?.id !== id) {
        throw new ApiError(
          "FORBIDDEN",
          "No tienes permisos para ver estas estadísticas",
          403,
        );
      }

      const stats = await prisma.user.findUnique({
        where: { id },
        select: {
          _count: {
            select: {
              requestedTickets: true,
              assignedTickets: true,
              comments: true,
            },
          },
          requestedTickets: {
            select: {
              status: true,
              priority: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          assignedTickets: {
            select: {
              status: true,
              priority: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      });

      if (!stats) {
        throw new ApiError("USER_NOT_FOUND", "Usuario no encontrado", 404);
      }

      // Calcular métricas
      const totalRequested = stats._count.requestedTickets;
      const totalAssigned = stats._count.assignedTickets;
      const totalComments = stats._count.comments;

      const requestedByStatus = stats.requestedTickets.reduce(
        (acc, ticket) => {
          acc[ticket.status] = (acc[ticket.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const assignedByStatus = stats.assignedTickets.reduce(
        (acc, ticket) => {
          acc[ticket.status] = (acc[ticket.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      res.json({
        success: true,
        data: {
          totalRequested,
          totalAssigned,
          totalComments,
          requestedByStatus,
          assignedByStatus,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}

export default UsersController;
