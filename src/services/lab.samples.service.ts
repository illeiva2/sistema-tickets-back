import { Prisma, type LabSite } from "@prisma/client";
import { prisma } from "../lib/database";
import { ApiError } from "../lib/errors";
import {
  buildDisplayName,
  formatAccession,
  looksLikeAccession,
  parseAccession,
  validateFieldValues,
  type FieldValues,
} from "../lib/labSamples";
import type {
  CreateFieldDefBody,
  CreateSampleBody,
  UpdateFieldDefBody,
  UpdateSampleBody,
} from "../validations/lab.samples";

/**
 * Registro de muestras.
 *
 * La muestra se registra una vez, recibe su accesión y desde ahí es la unidad
 * que enlaza los análisis de los cinco instrumentos. Este service es el único
 * lugar que asigna accesiones y arma nombres: si alguna vez hay que cambiar la
 * regla, se cambia acá y en lib/labSamples, no en cada pantalla.
 */

export interface FiltrosMuestras {
  site?: LabSite;
  kindId?: string;
  /** Accesión (exacta, tolerando tipeo) o texto libre contra el nombre. */
  q?: string;
  /** Fechas de PLANTA (YYYY-MM-DD), inclusive. */
  from?: string;
  to?: string;
}

/** Zona del molino. Argentina no aplica horario de verano desde 2009, así que el desfasaje es fijo. */
const TZ_PLANTA = "America/Argentina/Cordoba";
const OFFSET_PLANTA = "-03:00";

const esSoloFecha = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
const inicioDia = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00.000${OFFSET_PLANTA}`);
const finDia = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T23:59:59.999${OFFSET_PLANTA}`);

/** YYYY-MM-DD del instante, en fecha de planta. (en-CA formatea ISO por defecto.) */
const fechaPlanta = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_PLANTA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/** Una toma "en el futuro" es un reloj mal puesto, no una muestra. Se tolera un día de desfasaje. */
const MAX_FUTURO_MS = 24 * 60 * 60 * 1000;

const INCLUDE = {
  kind: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.LabSampleInclude;

const CAMPOS_ACTIVOS = {
  where: { isActive: true },
  orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
} satisfies Prisma.LabSampleKind$fieldsArgs;

/** Secuencias por laboratorio, creadas en el migration.sql (Prisma no las modela). */
const SECUENCIA: Record<LabSite, string> = {
  MOLINO: "lab_sample_seq_molino",
  ACOPIO: "lab_sample_seq_acopio",
};

export class LabSamplesService {
  // ─── Catálogo ──────────────────────────────────────────────────────────────

  /** Tipos de muestra con sus campos, para armar el formulario. */
  static async kinds(includeInactive = false) {
    return prisma.labSampleKind.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        fields: {
          where: includeInactive ? {} : { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
        },
      },
    });
  }

  static async createFieldDef(kindId: string, body: CreateFieldDefBody) {
    const kind = await prisma.labSampleKind.findUnique({ where: { id: kindId } });
    if (!kind) throw new ApiError("NOT_FOUND", "Tipo de muestra inexistente", 404);
    if (body.type === "SELECT" && !body.options?.length) {
      throw new ApiError("VALIDATION_ERROR", "Un campo de lista necesita al menos una opción", 400);
    }

    try {
      return await prisma.labSampleFieldDef.create({
        data: {
          kindId,
          key: body.key,
          label: body.label,
          type: body.type,
          required: body.required ?? false,
          options: body.type === "SELECT" ? body.options : undefined,
          inName: body.inName ?? false,
          namePrefix: body.namePrefix ?? null,
          placeholder: body.placeholder ?? null,
          sortOrder: body.sortOrder ?? 0,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError("CONFLICT", "Ya existe un campo con esa clave en este tipo de muestra", 409);
      }
      throw error;
    }
  }

  static async updateFieldDef(id: string, body: UpdateFieldDefBody) {
    const def = await prisma.labSampleFieldDef.findUnique({ where: { id } });
    if (!def) return null;
    if (def.type === "SELECT" && body.options !== undefined && body.options.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "Un campo de lista necesita al menos una opción", 400);
    }

    return prisma.labSampleFieldDef.update({
      where: { id },
      data: {
        label: body.label,
        required: body.required,
        // Las opciones solo tienen sentido en un SELECT; en otro tipo se ignoran.
        options: def.type === "SELECT" && body.options ? body.options : undefined,
        inName: body.inName,
        namePrefix: body.namePrefix,
        placeholder: body.placeholder,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }

  // ─── Muestras ──────────────────────────────────────────────────────────────

  static async summary() {
    const hoy = inicioDia(fechaPlanta(new Date()));
    // Últimos 7 días de planta, contando hoy.
    const hace7 = new Date(hoy.getTime() - 6 * 24 * 60 * 60 * 1000);

    const [total, today, last7d, porSitio] = await Promise.all([
      prisma.labSample.count({ where: { deletedAt: null } }),
      prisma.labSample.count({ where: { deletedAt: null, sampledAt: { gte: hoy } } }),
      prisma.labSample.count({ where: { deletedAt: null, sampledAt: { gte: hace7 } } }),
      prisma.labSample.groupBy({
        by: ["site"],
        _count: { _all: true },
        where: { deletedAt: null },
      }),
    ]);

    return {
      total,
      today,
      last7d,
      bySite: Object.fromEntries(porSitio.map((r) => [r.site, r._count._all])) as Partial<
        Record<LabSite, number>
      >,
    };
  }

  static async list(f: FiltrosMuestras, page: number, pageSize: number) {
    const where: Prisma.LabSampleWhereInput = { deletedAt: null };
    if (f.site) where.site = f.site;
    if (f.kindId) where.kindId = f.kindId;

    const desde = f.from && esSoloFecha(f.from) ? inicioDia(f.from.trim()) : undefined;
    const hasta = f.to && esSoloFecha(f.to) ? finDia(f.to.trim()) : undefined;
    if (desde || hasta) where.sampledAt = { gte: desde, lte: hasta };

    let warning: string | undefined;
    const q = f.q?.trim();
    if (q) {
      if (looksLikeAccession(q)) {
        const parsed = parseAccession(q);
        if (parsed) {
          where.accession = parsed.accession;
        } else {
          // Tiene forma de accesión pero el dígito no cierra: casi seguro un
          // error de tipeo. Se busca igual por texto, pero se avisa, porque
          // "sin resultados" a secas manda a la gente a revisar el registro
          // en lugar de lo que tipeó.
          warning = "Ese número no es una accesión válida: revisá el dígito verificador.";
          where.OR = [
            { accession: { contains: q.toUpperCase() } },
            { displayName: { contains: q, mode: "insensitive" } },
          ];
        }
      } else {
        where.OR = [
          { accession: { contains: q.toUpperCase() } },
          { displayName: { contains: q, mode: "insensitive" } },
        ];
      }
    }

    const [items, total] = await Promise.all([
      prisma.labSample.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ sampledAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.labSample.count({ where }),
    ]);

    return { items, total, page, pageSize, warning };
  }

  /**
   * Busca por accesión tolerando el tipeo ("m 0012 4"). Un dígito verificador
   * que no cierra es 400, no 404: la muestra puede existir perfectamente, lo
   * que está mal es lo que se tipeó.
   */
  static async getByAccession(input: string) {
    const parsed = parseAccession(input);
    if (!parsed) {
      throw new ApiError(
        "INVALID_ACCESSION",
        "Accesión inválida: revisá el número y el dígito verificador",
        400,
      );
    }
    return prisma.labSample.findFirst({
      where: { accession: parsed.accession, deletedAt: null },
      include: INCLUDE,
    });
  }

  static async create(userId: string, body: CreateSampleBody) {
    const kind = await prisma.labSampleKind.findFirst({
      where: { id: body.kindId, isActive: true },
      include: { fields: CAMPOS_ACTIVOS },
    });
    if (!kind) throw new ApiError("NOT_FOUND", "Tipo de muestra inexistente o inactivo", 404);

    const sampledAt = body.sampledAt ? new Date(body.sampledAt) : new Date();
    this.validarFecha(sampledAt);

    const { values, errors } = validateFieldValues(kind.fields, body.fields ?? {});
    if (errors.length > 0) {
      throw new ApiError("VALIDATION_ERROR", "Datos de la ficha inválidos", 400, errors);
    }

    const site = body.site as LabSite;
    const seq = await this.nextSeq(site);

    return prisma.labSample.create({
      data: {
        accession: formatAccession(site, seq),
        site,
        seq,
        kindId: kind.id,
        sampledAt,
        displayName: buildDisplayName(site, sampledAt, kind.fields, values),
        fields: values,
        notes: body.notes ?? null,
        createdById: userId,
      },
      include: INCLUDE,
    });
  }

  /**
   * Edita la ficha. `fields` reemplaza el juego completo de valores (el
   * formulario siempre manda todos) y el nombre se regenera: nunca puede quedar
   * un nombre que diga una cosa y una ficha que diga otra.
   */
  static async update(id: string, body: UpdateSampleBody) {
    const actual = await prisma.labSample.findFirst({
      where: { id, deletedAt: null },
      include: { kind: { include: { fields: CAMPOS_ACTIVOS } } },
    });
    if (!actual) return null;

    const sampledAt = body.sampledAt ? new Date(body.sampledAt) : actual.sampledAt;
    this.validarFecha(sampledAt);

    let values = actual.fields as unknown as FieldValues;
    if (body.fields) {
      const r = validateFieldValues(actual.kind.fields, body.fields);
      if (r.errors.length > 0) {
        throw new ApiError("VALIDATION_ERROR", "Datos de la ficha inválidos", 400, r.errors);
      }
      values = r.values;
    }

    return prisma.labSample.update({
      where: { id },
      data: {
        sampledAt,
        fields: values,
        displayName: buildDisplayName(actual.site, sampledAt, actual.kind.fields, values),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
      include: INCLUDE,
    });
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private static validarFecha(d: Date) {
    if (Number.isNaN(d.getTime())) {
      throw new ApiError("VALIDATION_ERROR", "Fecha de toma inválida", 400);
    }
    if (d.getTime() > Date.now() + MAX_FUTURO_MS) {
      throw new ApiError("VALIDATION_ERROR", "La fecha de toma está en el futuro", 400);
    }
  }

  /**
   * Siguiente correlativo del laboratorio. nextval() es atómico y no participa
   * de la transacción del insert: si el insert falla, el número queda quemado.
   * Es lo que se quiere — una accesión no se reutiliza jamás.
   */
  private static async nextSeq(site: LabSite): Promise<number> {
    const rows = await prisma.$queryRaw<{ seq: bigint | number }[]>`
      SELECT nextval(${SECUENCIA[site]}::regclass) AS seq
    `;
    const n = Number(rows[0]?.seq);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ApiError("INTERNAL_SERVER_ERROR", "No se pudo asignar el correlativo", 500);
    }
    return n;
  }
}

export default LabSamplesService;
