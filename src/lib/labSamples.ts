import type { LabFieldType, LabSite } from "@prisma/client";

/**
 * Registro de muestras: accesión, campos configurables y nombre descriptivo.
 *
 * Funciones puras a propósito (sin prisma, sin request): son las reglas que
 * definen qué es una accesión válida y cómo se arma el nombre, y tienen que
 * poder probarse solas y reutilizarse desde el agente cuando enlace mediciones.
 */

/** Zona del molino. Argentina no aplica horario de verano desde 2009. */
const TZ_PLANTA = "America/Argentina/Cordoba";

// ─── Accesión ────────────────────────────────────────────────────────────────
//
// "M-0012-4": prefijo del laboratorio, correlativo y dígito verificador.
//
// - El prefijo identifica la serie (M molino, A acopio/balanza), independientes.
// - El correlativo no significa nada: la identidad está en el número, los
//   atributos en la ficha. Por eso puede ser corto y tipearse a mano.
// - El dígito verificador es Luhn sobre (correlativo + dígito del sitio). Sin
//   lector de códigos, lo que hay que atajar es un dígito mal tipeado o dos
//   vecinos invertidos: Luhn detecta el 100% de lo primero y casi todo lo
//   segundo, y es el mismo algoritmo de las tarjetas, así que no hay que
//   explicárselo a nadie.
//
// El dígito del sitio va al FINAL del payload y no al principio, a propósito:
// Luhn alterna pesos desde la derecha, así que un cero a la izquierda no cambia
// el resultado. Con eso "M-12-4" y "M-0012-4" validan igual, y no dependemos de
// que todos rellenen con ceros de la misma manera.

export const SITE_PREFIX: Record<LabSite, string> = { MOLINO: "M", ACOPIO: "A" };
export const SITE_LABEL: Record<LabSite, string> = { MOLINO: "Molino", ACOPIO: "Acopio" };
const SITE_DIGIT: Record<LabSite, string> = { MOLINO: "1", ACOPIO: "2" };
const PREFIX_SITE: Record<string, LabSite> = { M: "MOLINO", A: "ACOPIO" };

/** Ancho mínimo del correlativo al mostrar. Crece solo cuando hace falta. */
const SEQ_WIDTH = 4;

export const luhnCheckDigit = (digits: string): number => {
  if (!/^\d+$/.test(digits)) throw new Error("Luhn: el payload debe ser solo dígitos");
  let suma = 0;
  // El dígito más a la derecha del payload se duplica: ocupará la posición par
  // una vez que el verificador se agregue al final.
  let duplicar = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (duplicar) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
    duplicar = !duplicar;
  }
  return (10 - (suma % 10)) % 10;
};

export const accessionCheckDigit = (site: LabSite, seq: number): number =>
  luhnCheckDigit(`${seq}${SITE_DIGIT[site]}`);

export const formatAccession = (site: LabSite, seq: number): string => {
  if (!Number.isInteger(seq) || seq <= 0) throw new Error("Accesión: correlativo inválido");
  return `${SITE_PREFIX[site]}-${String(seq).padStart(SEQ_WIDTH, "0")}-${accessionCheckDigit(site, seq)}`;
};

export interface ParsedAccession {
  site: LabSite;
  seq: number;
  /** Forma canónica, la que se guarda y se muestra. */
  accession: string;
}

const normalizar = (input: string) => input.trim().toUpperCase().replace(/[\s_.]/g, "");

/**
 * Interpreta lo que alguien tipeó: tolera minúsculas, espacios, sin guiones y
 * ceros de más o de menos. Devuelve null si el formato no cierra o el dígito
 * verificador no coincide — eso es un error de tipeo, no un "no existe".
 */
export const parseAccession = (input: string): ParsedAccession | null => {
  const m = /^([MA])-?(\d{1,9})-?(\d)$/.exec(normalizar(input));
  if (!m) return null;
  const site = PREFIX_SITE[m[1]];
  const seq = Number(m[2]);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  if (accessionCheckDigit(site, seq) !== Number(m[3])) return null;
  return { site, seq, accession: formatAccession(site, seq) };
};

/**
 * ¿Tiene forma de accesión (tenga o no el dígito correcto)? Sirve para decidir
 * si una búsqueda es por número exacto o por texto libre.
 */
export const looksLikeAccession = (input: string): boolean =>
  /^[MA]-?\d{1,9}-?\d$/.test(normalizar(input));

// ─── Campos configurables ────────────────────────────────────────────────────

/** Lo que el validador necesita de una LabSampleFieldDef. */
export interface FieldDefLike {
  key: string;
  label: string;
  type: LabFieldType;
  required: boolean;
  options: unknown;
  inName: boolean;
  namePrefix: string | null;
  sortOrder: number;
}

export type FieldValues = Record<string, string | number>;

export interface FieldError {
  field: string;
  message: string;
}

/** Opciones de un SELECT. `options` es Json en la base; acá se acota a strings. */
export const optionsOf = (def: Pick<FieldDefLike, "options">): string[] =>
  Array.isArray(def.options)
    ? def.options.filter((o): o is string => typeof o === "string")
    : [];

const MAX_TEXTO = 200;

/**
 * Valida y normaliza los valores contra las definiciones ACTIVAS del tipo.
 *
 * Devuelve solo keys definidas: una key desconocida es un error y no se guarda
 * en silencio, porque después nadie sabría qué era. Un string vacío cuenta como
 * "sin dato" (y falla si el campo es obligatorio), no como un valor.
 */
export const validateFieldValues = (
  defs: FieldDefLike[],
  raw: Record<string, unknown>,
): { values: FieldValues; errors: FieldError[] } => {
  const errors: FieldError[] = [];
  const values: FieldValues = {};
  const conocidas = new Set(defs.map((d) => d.key));

  for (const k of Object.keys(raw)) {
    if (!conocidas.has(k)) {
      errors.push({ field: `fields.${k}`, message: "Campo no definido para este tipo de muestra" });
    }
  }

  for (const def of defs) {
    const v = raw[def.key];
    const campo = `fields.${def.key}`;
    const vacio = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (vacio) {
      if (def.required) errors.push({ field: campo, message: `${def.label} es obligatorio` });
      continue;
    }

    switch (def.type) {
      case "TEXT": {
        if (typeof v !== "string") {
          errors.push({ field: campo, message: `${def.label} debe ser texto` });
          break;
        }
        const t = v.trim();
        if (t.length > MAX_TEXTO) {
          errors.push({ field: campo, message: `${def.label}: máximo ${MAX_TEXTO} caracteres` });
        } else {
          values[def.key] = t;
        }
        break;
      }
      case "NUMBER": {
        // Coma decimal: la gente del laboratorio tipea "12,5".
        const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
        if (!Number.isFinite(n)) {
          errors.push({ field: campo, message: `${def.label} debe ser un número` });
        } else {
          values[def.key] = n;
        }
        break;
      }
      case "SELECT": {
        const t = String(v).trim();
        if (!optionsOf(def).includes(t)) {
          errors.push({ field: campo, message: `${def.label}: "${t}" no es una opción válida` });
        } else {
          values[def.key] = t;
        }
        break;
      }
      case "DATETIME": {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) {
          errors.push({ field: campo, message: `${def.label}: fecha inválida` });
        } else {
          values[def.key] = d.toISOString();
        }
        break;
      }
    }
  }

  return { values, errors };
};

// ─── Nombre descriptivo ──────────────────────────────────────────────────────

/**
 * "07/09 10:30" en hora de planta, sin depender de la zona del proceso.
 *
 * El relleno a dos cifras se hace a mano: con hora y fecha juntas, el ICU de
 * Node ignora "2-digit" en es-AR y devuelve "7/9". Un nombre "7/9 10:30" al
 * lado de otro "07/09 10:30" parece dos formatos distintos, y no lo son.
 */
export const fmtPlanta = (d: Date): string => {
  const partes = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ_PLANTA,
    day: "numeric",
    month: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => (partes.find((p) => p.type === t)?.value ?? "").padStart(2, "0");
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
};

const MAX_NOMBRE = 160;

/**
 * "Molino · 3/0 · Lote 4521 · 07/09 10:30": sitio, los campos marcados inName
 * en su orden, y la fecha/hora de la toma. Es la "estética" del generador que
 * circuló por mail, pero la arma el sistema: nadie compone el nombre a mano.
 */
export const buildDisplayName = (
  site: LabSite,
  sampledAt: Date,
  defs: FieldDefLike[],
  values: FieldValues,
): string => {
  const partes: string[] = [SITE_LABEL[site]];
  const enNombre = defs.filter((d) => d.inName).sort((a, b) => a.sortOrder - b.sortOrder);
  for (const def of enNombre) {
    const v = values[def.key];
    if (v === undefined || v === null || v === "") continue;
    const texto = def.type === "DATETIME" ? fmtPlanta(new Date(String(v))) : String(v);
    partes.push(`${def.namePrefix ?? ""}${texto}`);
  }
  partes.push(fmtPlanta(sampledAt));
  return partes.join(" · ").slice(0, MAX_NOMBRE);
};
