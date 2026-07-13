import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(1, "Contraseña requerida"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token requerido"),
});

export const oauthExchangeSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "Código OAuth inválido"),
});

export type LoginRequest = z.infer<typeof loginSchema>;
export type RefreshTokenRequest = z.infer<typeof refreshTokenSchema>;
export type OAuthExchangeRequest = z.infer<typeof oauthExchangeSchema>;
