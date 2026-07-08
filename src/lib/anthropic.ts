import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

// Cliente compartido. Si no hay API key en env, isAnthropicConfigured()
// devuelve false y los endpoints que dependen de la IA pueden responder
// 503 con un mensaje claro en lugar de fallar con un error opaco.
let client: Anthropic | null = null;

export const isAnthropicConfigured = (): boolean =>
  config.anthropic.apiKey.trim().length > 0;

export const getAnthropicClient = (): Anthropic => {
  if (!isAnthropicConfigured()) {
    throw new Error(
      "ANTHROPIC_API_KEY no esta configurada. La funcionalidad de IA esta deshabilitada.",
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return client;
};

// El modelo recomendado por defecto. Si en el futuro queremos cambiar (p. ej.
// para abaratar con un modelo mas chico) lo centralizamos aca.
export const RESOURCE_DRAFT_MODEL = "claude-opus-4-7";

// Modelo del asistente conversacional de tickets. Haiku: barato y rapido,
// suficiente para respuestas cortas ancladas en articulos de la KB.
export const ASSISTANT_MODEL = "claude-haiku-4-5-20251001";
