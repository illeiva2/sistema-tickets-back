import { z } from "zod";

export const assistantChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z
          .string()
          .min(1, "Mensaje vacío")
          .max(2000, "Mensaje demasiado largo"),
      }),
    )
    .min(1, "La conversación está vacía")
    .max(12, "La conversación es demasiado larga; creá el ticket directamente")
    .refine(
      (msgs) => msgs[msgs.length - 1].role === "user",
      "El último mensaje debe ser del usuario",
    ),
});

export type AssistantChatRequest = z.infer<typeof assistantChatSchema>;
