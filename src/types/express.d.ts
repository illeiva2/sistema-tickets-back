import "express";
import type { UserRole } from "@prisma/client";

// Type augmentation global para Express. Define el shape de Express.User
// (al que apunta req.user gracias a passport types) y agrega requestId
// al Request. Con esto, todos los controllers ven req.user con la forma
// correcta sin necesidad de un AuthenticatedRequest custom ni `as any`.
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      role: UserRole;
      mustChangePassword?: boolean;
    }

    interface Request {
      requestId?: string;
    }
  }
}

export {};
