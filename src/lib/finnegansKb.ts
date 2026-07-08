import { config } from "../config";
import { ApiError } from "./errors";
import { logger } from "./logger";

// Cliente HTTP de la Base de Conocimiento oficial de Finnegans.
//
// Habla con el microservicio Python (proyecto finnegans-kb-mcp -> api.py),
// que expone la busqueda sobre el corpus de bc.finneg.com como JSON. NO usa
// el protocolo MCP: MCP es para clientes LLM, no para un backend web.
//
// Si config.finnegansKb.baseUrl esta vacio, isFinnegansKbConfigured() devuelve
// false y las features que dependen de la KB pueden responder 503 con un
// mensaje claro en vez de fallar de forma opaca (mismo patron que lib/anthropic).

export interface KbResultado {
  id: number | string;
  titulo: string;
  slug: string;
  categoria: string;
  tags: string[];
  url: string;
  extracto: string;
  score: number;
}

export interface KbRespuestaBusqueda {
  consulta: string;
  modo_pedido: string;
  modo_usado: string;
  total: number;
  resultados: KbResultado[];
  error: string | null;
}

export interface KbArticulo extends Omit<KbResultado, "score"> {
  contenido: string;
}

export type KbModo = "hibrido" | "semantico" | "palabras";

export const isFinnegansKbConfigured = (): boolean =>
  config.finnegansKb.baseUrl.trim().length > 0;

const baseUrl = (): string => config.finnegansKb.baseUrl.replace(/\/+$/, "");

// Wrapper de fetch con timeout (AbortController) y manejo de errores tipado.
// Node >= 18 trae fetch global, asi que no hace falta dependencia extra.
async function pedir<T>(path: string): Promise<T> {
  if (!isFinnegansKbConfigured()) {
    throw new ApiError(
      "KB_NOT_CONFIGURED",
      "La Base de Conocimiento de Finnegans no esta configurada. Falta FINNEGANS_KB_URL en el servidor.",
      503,
    );
  }

  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.finnegansKb.timeoutMs,
  );

  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.finnegansKb.apiToken) {
    headers.Authorization = `Bearer ${config.finnegansKb.apiToken}`;
  }

  try {
    const res = await fetch(url, { headers, signal: controller.signal });

    if (res.status === 404) {
      throw new ApiError("KB_NOT_FOUND", "Recurso no encontrado en la KB", 404);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, url: path, body: body.slice(0, 300) },
        "Respuesta no OK del servicio de KB",
      );
      throw new ApiError(
        "KB_UPSTREAM_ERROR",
        "El servicio de Base de Conocimiento respondio con un error.",
        502,
      );
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    if (err?.name === "AbortError") {
      logger.warn({ url: path }, "Timeout consultando el servicio de KB");
      throw new ApiError(
        "KB_TIMEOUT",
        "El servicio de Base de Conocimiento tardo demasiado en responder.",
        504,
      );
    }
    logger.error({ err, url: path }, "Error consultando el servicio de KB");
    throw new ApiError(
      "KB_UNAVAILABLE",
      "No se pudo contactar el servicio de Base de Conocimiento.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Busca articulos en la KB oficial. `limite` se acota 1..50; `modo` default hibrido.
export async function buscarKb(
  consulta: string,
  opts: { limite?: number; modo?: KbModo } = {},
): Promise<KbRespuestaBusqueda> {
  const limite = Math.min(Math.max(opts.limite ?? 5, 1), 50);
  const modo = opts.modo ?? "hibrido";
  const q = encodeURIComponent(consulta.trim());
  return pedir<KbRespuestaBusqueda>(
    `/buscar?q=${q}&limite=${limite}&modo=${modo}`,
  );
}

// Trae un articulo completo (markdown) por id numerico, slug o URL.
export async function obtenerArticuloKb(
  idOrSlug: string,
): Promise<KbArticulo> {
  return pedir<KbArticulo>(`/articulo/${encodeURIComponent(idOrSlug)}`);
}
