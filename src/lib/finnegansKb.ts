import { config } from "../config";
import { ApiError } from "./errors";
import { logger } from "./logger";

// Cliente de la Base de Conocimiento oficial de Finnegans (bc.finneg.com).
//
// bc.finneg.com es un foro Discourse con la API JSON publica habilitada:
// cualquier ruta con sufijo .json devuelve JSON sin autenticacion. Usamos
// su busqueda nativa (/search.json) en vivo — no indexamos ni copiamos el
// corpus, asi las sugerencias siempre reflejan la documentacion vigente.
//
// Si config.finnegansKb.disabled es true (FINNEGANS_KB_DISABLED=true),
// isFinnegansKbConfigured() devuelve false y las features responden 503
// con mensaje claro (mismo patron que lib/anthropic).

export interface KbSugerencia {
  topicId: number;
  titulo: string;
  slug: string;
  url: string;
  extracto: string;
  categoria: string; // nombre de la categoria de Discourse ("" si no se pudo resolver)
  tags: string[];
}

// ─── Shapes crudos de la API de Discourse (solo lo que usamos) ───────────────

interface DiscoursePost {
  topic_id: number;
  blurb?: string;
}

interface DiscourseTopic {
  id: number;
  title: string;
  slug: string;
  category_id?: number;
  // Segun la version de Discourse, tags puede ser string[] u objetos {name}.
  tags?: Array<string | { name?: string }>;
}

interface DiscourseSearchResponse {
  posts?: DiscoursePost[];
  topics?: DiscourseTopic[];
}

interface DiscourseCategory {
  id: number;
  name: string;
  subcategory_list?: DiscourseCategory[];
}

export const isFinnegansKbConfigured = (): boolean =>
  !config.finnegansKb.disabled &&
  config.finnegansKb.baseUrl.trim().length > 0;

const baseUrl = (): string => config.finnegansKb.baseUrl.replace(/\/+$/, "");

// ─── fetch con timeout y errores tipados ──────────────────────────────────────

async function pedir<T>(path: string): Promise<T> {
  if (!isFinnegansKbConfigured()) {
    throw new ApiError(
      "KB_NOT_CONFIGURED",
      "La Base de Conocimiento de Finnegans esta deshabilitada en el servidor.",
      503,
    );
  }

  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.finnegansKb.timeoutMs,
  );

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 404) {
      throw new ApiError("KB_NOT_FOUND", "Recurso no encontrado en la KB", 404);
    }
    if (res.status === 429) {
      logger.warn({ url: path }, "Rate limit de Discourse en la KB");
      throw new ApiError(
        "KB_RATE_LIMITED",
        "La Base de Conocimiento recibio demasiadas consultas. Proba de nuevo en unos segundos.",
        429,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, url: path, body: body.slice(0, 300) },
        "Respuesta no OK de la KB de Finnegans",
      );
      throw new ApiError(
        "KB_UPSTREAM_ERROR",
        "La Base de Conocimiento de Finnegans respondio con un error.",
        502,
      );
    }
    return (await res.json()) as T;
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    if (err?.name === "AbortError") {
      logger.warn({ url: path }, "Timeout consultando la KB de Finnegans");
      throw new ApiError(
        "KB_TIMEOUT",
        "La Base de Conocimiento tardo demasiado en responder.",
        504,
      );
    }
    logger.error({ err, url: path }, "Error consultando la KB de Finnegans");
    throw new ApiError(
      "KB_UNAVAILABLE",
      "No se pudo contactar la Base de Conocimiento de Finnegans.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Cache de categorias (id -> nombre) ───────────────────────────────────────
// Las categorias de un Discourse cambian rarisimo; 1 request cada 1h alcanza.

const CATEGORIES_TTL_MS = 60 * 60 * 1000;
let categoriesCache: { at: number; map: Map<number, string> } | null = null;

async function getCategoryNames(): Promise<Map<number, string>> {
  if (categoriesCache && Date.now() - categoriesCache.at < CATEGORIES_TTL_MS) {
    return categoriesCache.map;
  }
  const map = new Map<number, string>();
  try {
    const data = await pedir<{
      category_list?: { categories?: DiscourseCategory[] };
    }>("/categories.json");
    const walk = (cats: DiscourseCategory[]) => {
      for (const c of cats) {
        map.set(c.id, c.name);
        if (c.subcategory_list) walk(c.subcategory_list);
      }
    };
    walk(data.category_list?.categories ?? []);
    categoriesCache = { at: Date.now(), map };
  } catch (err) {
    // Best-effort: sin nombres de categoria las sugerencias siguen sirviendo.
    logger.warn({ err }, "No se pudieron cargar categorias de la KB");
  }
  return map;
}

// ─── Cache corto de busquedas ─────────────────────────────────────────────────
// Evita repetir la misma consulta contra Discourse (ej: refrescos de pagina).

const SEARCH_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, { at: number; data: KbSugerencia[] }>();

// Exportado solo para poder resetear estado entre tests.
export const __clearKbCaches = () => {
  categoriesCache = null;
  searchCache.clear();
};

// ─── Busqueda ─────────────────────────────────────────────────────────────────

// Busca en la KB oficial. Devuelve hasta `limite` topics (deduplicados),
// respetando el ranking nativo de Discourse.
export async function buscarKb(
  consulta: string,
  limite = 5,
): Promise<KbSugerencia[]> {
  const q = consulta.trim();
  if (!q) return [];
  const lim = Math.min(Math.max(limite, 1), 20);

  const cacheKey = `${q.toLowerCase()}::${lim}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) {
    return cached.data;
  }

  const [res, categorias] = await Promise.all([
    pedir<DiscourseSearchResponse>(
      `/search.json?q=${encodeURIComponent(q)}`,
    ),
    getCategoryNames(),
  ]);

  const topicsById = new Map<number, DiscourseTopic>(
    (res.topics ?? []).map((t) => [t.id, t]),
  );

  const vistos = new Set<number>();
  const sugerencias: KbSugerencia[] = [];
  for (const post of res.posts ?? []) {
    if (sugerencias.length >= lim) break;
    if (vistos.has(post.topic_id)) continue;
    const topic = topicsById.get(post.topic_id);
    if (!topic) continue;
    vistos.add(post.topic_id);

    const tags = (topic.tags ?? [])
      .map((t) => (typeof t === "string" ? t : (t?.name ?? "")))
      .filter(Boolean);

    sugerencias.push({
      topicId: topic.id,
      titulo: topic.title,
      slug: topic.slug,
      url: `${baseUrl()}/t/${topic.slug}/${topic.id}`,
      extracto: (post.blurb ?? "").trim(),
      categoria:
        (topic.category_id !== undefined
          ? categorias.get(topic.category_id)
          : "") ?? "",
      tags,
    });
  }

  // Guardar en cache con evicción naive si crece de mas.
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey !== undefined) searchCache.delete(firstKey);
  }
  searchCache.set(cacheKey, { at: Date.now(), data: sugerencias });

  return sugerencias;
}
