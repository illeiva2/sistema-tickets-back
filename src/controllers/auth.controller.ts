import { Request, Response, NextFunction } from "express";
import { AuthService } from "../services/auth.service";
import { AuthenticatedRequest } from "../middleware/auth";
import { loginSchema, refreshTokenSchema, registerSchema } from "../validations/auth";
import { validate } from "../middleware/validation";
import { z } from "zod";

export class AuthController {
  static login = [
    validate(z.object({ body: loginSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, password } = req.body;
        const result = await AuthService.login(email, password);
        
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static register = [
    validate(z.object({ body: registerSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name, email, role, googleAccessToken } = req.body;
        const result = await AuthService.register(name, email, role, googleAccessToken);
        
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static setupPassword = [
    validate(z.object({ 
      body: z.object({
        newPassword: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
      })
    })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { newPassword } = req.body;
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).json({
            success: false,
            error: {
              code: "NO_TOKEN",
              message: "Token de acceso requerido",
            },
          });
        }

        const token = authHeader.substring(7);
        const result = await AuthService.setupPassword(token, newPassword);
        
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static refreshToken = [
    validate(z.object({ body: refreshTokenSchema })),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { refreshToken } = req.body;
        const result = await AuthService.refreshToken(refreshToken);
        
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        next(error);
      }
    },
  ];

  static me = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Usuario no autenticado",
          },
        });
      }

      const user = await AuthService.getCurrentUser(req.user.id);
      
      res.json({
        success: true,
        data: { user },
      });
    } catch (error) {
      next(error);
    }
  };
}
