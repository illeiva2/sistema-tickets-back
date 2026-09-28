import { prisma } from "../lib/database";

/**
 * Empresas de granos del ERP para el campo "Empresa" de la muestra de recepción.
 *
 * La fuente es un dataset del DataWarehouse de Finnegans (Aurora), que el ERP
 * refresca cada noche a partir del SP `USR_LAB_PRODUCTORES_GRANOS_DW`:
 * organizaciones con el tag GRANOS (árbol "COMPRAS → GRANOS", o ventas) con
 * CUIT, localidad y provincia. El job nocturno (GitHub Actions) lee ese dataset
 * y lo vuelca acá con upsert; lo que deja de venir se marca `deletedAt`, nunca
 * se borra. El formulario lo consume por las sugerencias del campo.
 *
 * Todo lo que llega del DWH es texto (la replicación deja cada columna como
 * texto y agrega `base`), así que la normalización es explícita.
 */

export type FilaDataset = Record<string, unknown>;

export interface ProductorNormalizado {
  id: number;
  cuit: string | null;
  codigo: string | null;
  nombre: string;
  razonSocial: string | null;
  activo: boolean;
  esProveedor: boolean;
  esCliente: boolean;
  tagCompras: boolean;
  tagVentas: boolean;
  localidad: string | null;
  provincia: string | null;
  localidadAfip: string | null;
  base: string | null;
}

export interface ResultadoSync {
  runId: string;
  status: "OK" | "ERROR";
  dataset: string;
  total: number;
  upserted: number;
  removed: number;
  error?: string;
}

export const DATASET_DEFAULT = "grf_lab_productores_granos";
const DATASET_RE = /^[a-z][a-z0-9_]{2,62}$/;

/** Tabla del DWH a leer. Se puede cambiar por env sin tocar código (la define el usuario al dar de alta el dataset). */
export const datasetNombre = (): string => {
  const n = (process.env.LAB_PRODUCTORES_DATASET?.trim() || DATASET_DEFAULT).toLowerCase();
  if (!DATASET_RE.test(n)) throw new Error(`LAB_PRODUCTORES_DATASET inválido: "${n}"`);
  return n;
};

const FORMATO_URL =
  "DWH_DATABASE_URL no es una URL de Postgres válida. Formato: postgresql://usuario:clave@host:5432/base?sslmode=require " +
  "(sin comillas; si la clave tiene @ # / % : ? o espacios, codificalos: @=%40 #=%23 /=%2F %=%25 :=%3A ?=%3F espacio=%20)";

/**
 * URL del DWH lista para Prisma. El DWH es RDS con una CA privada que Node no
 * conoce: se cifra la conexión sin validar la cadena, igual que hace la
 * extranet. Se limpian los parámetros de libpq que Prisma no entiende. Nunca
 * repite el valor en el error: puede llevar la clave.
 */
export const urlDwh = (raw: string | undefined): string => {
  const valor = (raw ?? "").trim().replace(/^["']+|["']+$/g, "");
  if (!valor) throw new Error("DWH_DATABASE_URL no está definida");
  let u: URL;
  try {
    u = new URL(valor);
  } catch {
    throw new Error(FORMATO_URL);
  }
  if ((u.protocol !== "postgresql:" && u.protocol !== "postgres:") || !u.hostname || !u.username) {
    throw new Error(FORMATO_URL);
  }
  u.searchParams.delete("uselibpqcompat");
  u.searchParams.set("sslmode", "require");
  u.searchParams.set("sslaccept", "accept_invalid_certs");
  u.searchParams.set("connection_limit", "2");
  return u.toString();
};

/** Si el dataset trae menos que esta fracción de lo vigente, algo se rompió aguas arriba: no se aplica. */
const CAIDA_SOSPECHOSA = 0.5;
/** Más viejo que esto, la lista se muestra como desactualizada. */
const FRESCURA_MS = 2 * 24 * 60 * 60 * 1000;
const LOTE = 100;

const texto = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t.slice(0, max);
};

const entero = (v: unknown): number | null => {
  const t = texto(v, 20);
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};

const bandera = (v: unknown): boolean => {
  const t = texto(v, 10)?.toLowerCase();
  return t === "1" || t === "true" || t === "t" || t === "si" || t === "sí";
};

/** Acepta los alias del SP (`razon_social`) y la forma sin guiones de otros datasets (`razonsocial`). */
const col = (r: FilaDataset, ...nombres: string[]): unknown => {
  for (const n of nombres) if (r[n] !== undefined) return r[n];
  return undefined;
};

/** Una fila del dataset a productor. null si no tiene id o nombre: no se puede sugerir. */
export const normalizarFila = (r: FilaDataset): ProductorNormalizado | null => {
  const id = entero(col(r, "organizacion_id", "organizacionid", "id"));
  const razonSocial = texto(col(r, "razon_social", "razonsocial"), 200);
  const nombre = texto(col(r, "nombre"), 200) ?? razonSocial;
  if (!id || !nombre) return null;
  return {
    id,
    cuit: texto(col(r, "cuit"), 20),
    codigo: texto(col(r, "codigo"), 40),
    nombre,
    razonSocial,
    activo: bandera(col(r, "activo")),
    esProveedor: bandera(col(r, "es_proveedor", "esproveedor")),
    esCliente: bandera(col(r, "es_cliente", "escliente")),
    tagCompras: bandera(col(r, "tag_compras", "tagcompras")),
    tagVentas: bandera(col(r, "tag_ventas", "tagventas")),
    localidad: texto(col(r, "localidad"), 120),
    provincia: texto(col(r, "provincia"), 80),
    localidadAfip: texto(col(r, "localidad_afip", "localidadafip"), 20),
    base: texto(col(r, "base"), 40),
  };
};

export interface SugerenciaEmpresa {
  value: string;
  label: string;
}

export default class LabProductoresService {
  /**
   * Vuelca el dataset en `lab_productores`. `leer` es lo único que toca el DWH,
   * así el resto se prueba sin conexión. Nunca borra: da de baja lógica lo que
   * dejó de venir, y si el dataset viene vacío o con una caída brusca, no toca
   * nada y deja la corrida en ERROR.
   */
  static async sincronizar(leer: () => Promise<FilaDataset[]>, dataset = datasetNombre()): Promise<ResultadoSync> {
    const run = await prisma.labProductorSync.create({ data: { status: "RUNNING", dataset } });
    try {
      const crudas = await leer();
      const porId = new Map<number, ProductorNormalizado>();
      for (const cruda of crudas) {
        const p = normalizarFila(cruda);
        if (p) porId.set(p.id, p);
      }
      const lista = [...porId.values()];
      const total = lista.length;
      if (total === 0) {
        // Si vinieron filas pero ninguna sirve, lo más probable es que el dataset
        // tenga otras columnas: se nombran (son metadatos, no datos) para
        // corregir el SP o el normalizador sin tener que entrar al DWH.
        if (crudas.length > 0) {
          throw new Error(
            `Ninguna de las ${crudas.length} filas del dataset tiene id y nombre reconocibles; ` +
              `columnas recibidas: ${Object.keys(crudas[0]).join(", ")}`,
          );
        }
        throw new Error("El dataset vino vacío; la lista actual queda como está");
      }

      const vigentes = await prisma.labProductor.count({ where: { deletedAt: null } });
      if (vigentes > 0 && total < vigentes * CAIDA_SOSPECHOSA) {
        throw new Error(
          `El dataset trae ${total} empresas y la lista tiene ${vigentes}: caída sospechosa, no se aplica`,
        );
      }

      const ahora = new Date();
      let upserted = 0;
      for (let i = 0; i < lista.length; i += LOTE) {
        const lote = lista.slice(i, i + LOTE);
        await prisma.$transaction(
          lote.map((p) =>
            prisma.labProductor.upsert({
              where: { id: p.id },
              create: { ...p, syncedAt: ahora, deletedAt: null },
              update: { ...p, syncedAt: ahora, deletedAt: null },
            }),
          ),
        );
        upserted += lote.length;
      }
      const baja = await prisma.labProductor.updateMany({
        where: { deletedAt: null, id: { notIn: lista.map((p) => p.id) } },
        data: { deletedAt: ahora },
      });

      await prisma.labProductorSync.update({
        where: { id: run.id },
        data: { status: "OK", finishedAt: new Date(), total, upserted, removed: baja.count },
      });
      return { runId: run.id, status: "OK", dataset, total, upserted, removed: baja.count };
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await prisma.labProductorSync.update({
        where: { id: run.id },
        data: { status: "ERROR", finishedAt: new Date(), error },
      });
      return { runId: run.id, status: "ERROR", dataset, total: 0, upserted: 0, removed: 0, error };
    }
  }

  /** Empresas para el desplegable: el nombre es lo que se guarda; CUIT y localidad ayudan a elegir la correcta. */
  static async sugerencias(): Promise<SugerenciaEmpresa[]> {
    const filas = await prisma.labProductor.findMany({
      where: { deletedAt: null, activo: true },
      orderBy: { nombre: "asc" },
      select: { nombre: true, cuit: true, localidad: true, provincia: true },
    });
    return filas.map((p) => ({
      value: p.nombre,
      label: [p.cuit, [p.localidad, p.provincia].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
    }));
  }

  /** Estado de la lista para el catálogo: cuántas hay y si el job viene corriendo. */
  static async estado() {
    const [total, activos, ultima, ultimaOk] = await Promise.all([
      prisma.labProductor.count({ where: { deletedAt: null } }),
      prisma.labProductor.count({ where: { deletedAt: null, activo: true } }),
      prisma.labProductorSync.findFirst({ orderBy: { startedAt: "desc" } }),
      prisma.labProductorSync.findFirst({ where: { status: "OK" }, orderBy: { startedAt: "desc" } }),
    ]);
    const fechaOk = ultimaOk?.finishedAt ?? ultimaOk?.startedAt ?? null;
    let dataset: string | null = null;
    try {
      dataset = datasetNombre();
    } catch {
      dataset = null;
    }
    return {
      total,
      activos,
      dataset,
      ultimaCorrida: ultima
        ? { at: ultima.finishedAt ?? ultima.startedAt, status: ultima.status, total: ultima.total, error: ultima.error }
        : null,
      ultimaOk: fechaOk,
      desactualizado: !fechaOk || Date.now() - fechaOk.getTime() > FRESCURA_MS,
    };
  }
}
