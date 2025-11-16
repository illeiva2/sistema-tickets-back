import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(1, "Contraseña requerida"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token requerido"),
});

export const registerSchema = z.object({
  name: z.string().min(2, "El nombre debe tener al menos 2 caracteres"),
  email: z.string().email("Email inválido"),
  role: z.enum(["USER", "AGENT", "ADMIN"], {
    errorMap: () => ({ message: "Rol inválido" }),
  }),
  googleAccessToken: z.string().min(1, "Token de Google requerido"),
});

export type LoginRequest = z.infer<typeof loginSchema>;
export type RefreshTokenRequest = z.infer<typeof refreshTokenSchema>;
export type RegisterRequest = z.infer<typeof registerSchema>;
