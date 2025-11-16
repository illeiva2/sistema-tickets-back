import { z } from "zod";

export const createCommentSchema = z.object({
  message: z.string().min(1, "Mensaje requerido").max(2000, "Mensaje muy largo"),
});

export type CreateCommentRequest = z.infer<typeof createCommentSchema>;
