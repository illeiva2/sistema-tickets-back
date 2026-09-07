import { describe, it, expect } from "vitest";
import {
  accessionCheckDigit,
  buildDisplayName,
  condicionesDe,
  extractAccession,
  formatAccession,
  looksLikeAccession,
  luhnCheckDigit,
  parseAccession,
  validateFieldValues,
  type FieldDefLike,
} from "../src/lib/labSamples";

// Reglas puras del registro de muestras: accesión con dígito verificador,
// validación de campos configurables y nombre descriptivo. Sin base: son las
// definiciones que tienen que valer igual en la API y en el agente.

describe("luhnCheckDigit", () => {
  it("reproduce el ejemplo clásico de Luhn", () => {
    // 7992739871 -> 3 (79927398713 es el número completo del ejemplo canónico)
    expect(luhnCheckDigit("7992739871")).toBe(3);
  });

  it("rechaza payloads que no son dígitos", () => {
    expect(() => luhnCheckDigit("12a")).toThrow();
  });
});

describe("accesión", () => {
  it("formatea con prefijo, correlativo a 4 cifras y dígito verificador", () => {
    // payload "121": 1→2, 2→2, 1→2 = 6 -> verificador 4
    expect(formatAccession("MOLINO", 12)).toBe("M-0012-4");
    // payload "122": 2→4, 2→2, 1→2 = 8 -> verificador 2
    expect(formatAccession("ACOPIO", 12)).toBe("A-0012-2");
  });

  it("el correlativo crece más allá de 4 cifras sin truncar", () => {
    expect(formatAccession("MOLINO", 12345)).toMatch(/^M-12345-\d$/);
  });

  it("el mismo número da dígitos distintos en cada laboratorio", () => {
    expect(accessionCheckDigit("MOLINO", 12)).not.toBe(accessionCheckDigit("ACOPIO", 12));
  });

  it("parsea la forma canónica y hace roundtrip", () => {
    for (const seq of [1, 7, 12, 999, 4321, 10000]) {
      for (const site of ["MOLINO", "ACOPIO"] as const) {
        const acc = formatAccession(site, seq);
        expect(parseAccession(acc)).toEqual({ site, seq, accession: acc });
      }
    }
  });

  it("tolera lo que tipea la gente: minúsculas, espacios, sin guiones, ceros de más o de menos", () => {
    const esperado = { site: "MOLINO", seq: 12, accession: "M-0012-4" };
    expect(parseAccession("m-0012-4")).toEqual(esperado);
    expect(parseAccession("M 0012 4")).toEqual(esperado);
    expect(parseAccession("M00124")).toEqual(esperado);
    expect(parseAccession("M-12-4")).toEqual(esperado);
    expect(parseAccession("M-000012-4")).toEqual(esperado);
  });

  it("devuelve null si el dígito verificador no coincide (error de tipeo)", () => {
    expect(parseAccession("M-0012-5")).toBeNull();
    // Mismo número, laboratorio equivocado: el dígito del sitio también protege.
    expect(parseAccession("A-0012-4")).toBeNull();
  });

  it("devuelve null ante formatos que no son una accesión", () => {
    expect(parseAccession("")).toBeNull();
    expect(parseAccession("3/0")).toBeNull();
    expect(parseAccession("X-0012-4")).toBeNull();
    expect(parseAccession("M-0000-0")).toBeNull();
  });

  it("looksLikeAccession distingue búsqueda por número de búsqueda por texto", () => {
    expect(looksLikeAccession("m-0012-4")).toBe(true);
    expect(looksLikeAccession("M00125")).toBe(true);
    expect(looksLikeAccession("Tapera")).toBe(false);
    expect(looksLikeAccession("3/0")).toBe(false);
  });
});

describe("extractAccession (lo que el operario tipeó en el equipo)", () => {
  it("el caso normal: solo el número, con cualquier tipeo", () => {
    expect(extractAccession("M-0012-4")?.accession).toBe("M-0012-4");
    expect(extractAccession(" m00124 ")?.accession).toBe("M-0012-4");
  });

  it("encuentra la accesión aunque venga acompañada de texto", () => {
    expect(extractAccession("M-0012-4 3/0")?.accession).toBe("M-0012-4");
    expect(extractAccession("Tapera M00124")?.accession).toBe("M-0012-4");
    expect(extractAccession("a-0012-2 / silo 3")?.accession).toBe("A-0012-2");
  });

  it("no adivina: un token con dígito incorrecto o texto sin accesión da null", () => {
    expect(extractAccession("M-0012-5")).toBeNull();
    expect(extractAccession("TAPERA 02/09/26 02:00-07:00")).toBeNull();
    expect(extractAccession("FORZANI TAPERA LOTE 160C 30/7")).toBeNull();
    expect(extractAccession("")).toBeNull();
    expect(extractAccession(null)).toBeNull();
  });

  it("no toma dígitos pegados a otro número como accesión", () => {
    // "1M00124" no es una accesión: el token está precedido por un dígito.
    expect(extractAccession("1M00124")).toBeNull();
  });
});

const DEFS: FieldDefLike[] = [
  {
    key: "turno",
    label: "Turno",
    type: "SELECT",
    required: true,
    options: ["1° Noche", "2° Mañana", "3° Tarde"],
    inName: false,
    namePrefix: null,
    sortOrder: 1,
  },
  {
    key: "producto",
    label: "Producto",
    type: "SELECT",
    required: true,
    options: ["3/0", "4/0", "Tapera"],
    inName: true,
    namePrefix: null,
    sortOrder: 2,
  },
  {
    key: "lote",
    label: "Lote",
    type: "TEXT",
    required: false,
    options: null,
    inName: true,
    namePrefix: "Lote ",
    sortOrder: 3,
  },
  {
    key: "humedad_ref",
    label: "Humedad de referencia",
    type: "NUMBER",
    required: false,
    options: null,
    inName: false,
    namePrefix: null,
    sortOrder: 4,
  },
];

describe("validateFieldValues", () => {
  it("normaliza valores válidos: recorta texto y acepta coma decimal", () => {
    const { values, errors } = validateFieldValues(DEFS, {
      turno: "2° Mañana",
      producto: "3/0",
      lote: "  4521 ",
      humedad_ref: "12,5",
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({ turno: "2° Mañana", producto: "3/0", lote: "4521", humedad_ref: 12.5 });
  });

  it("falla los obligatorios ausentes o vacíos y no los inventa", () => {
    const { values, errors } = validateFieldValues(DEFS, { turno: "", producto: undefined });
    expect(errors.map((e) => e.field).sort()).toEqual(["fields.producto", "fields.turno"]);
    expect(values).toEqual({});
  });

  it("rechaza una opción que no está en el SELECT", () => {
    const { errors } = validateFieldValues(DEFS, { turno: "2° Mañana", producto: "Semolín" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("fields.producto");
  });

  it("rechaza keys que el tipo no define en lugar de guardarlas en silencio", () => {
    const { errors } = validateFieldValues(DEFS, {
      turno: "2° Mañana",
      producto: "3/0",
      silo: "S2",
    });
    expect(errors).toEqual([
      { field: "fields.silo", message: "Campo no definido para este tipo de muestra" },
    ]);
  });

  it("rechaza números no numéricos", () => {
    const { errors } = validateFieldValues(DEFS, {
      turno: "2° Mañana",
      producto: "3/0",
      humedad_ref: "doce",
    });
    expect(errors.map((e) => e.field)).toEqual(["fields.humedad_ref"]);
  });
});

const DEFS_GRANO: FieldDefLike[] = [
  {
    key: "brotado",
    label: "Brotado",
    type: "BOOLEAN",
    required: false,
    options: null,
    inName: false,
    namePrefix: null,
    sortOrder: 1,
    isCondition: true,
  },
  {
    key: "insectos",
    label: "Insectos",
    type: "SELECT",
    required: false,
    options: ["No", "Vivos", "Muertos"],
    inName: false,
    namePrefix: null,
    sortOrder: 2,
    isCondition: true,
    conditionValues: ["Vivos", "Muertos"],
  },
  {
    key: "olor",
    label: "Olor",
    type: "SELECT",
    required: false,
    options: ["No", "Poco", "Mucho"],
    inName: false,
    namePrefix: null,
    sortOrder: 3,
    isCondition: true,
    conditionValues: null,
  },
  {
    key: "empresa",
    label: "Empresa",
    type: "TEXT",
    required: false,
    options: null,
    inName: true,
    namePrefix: null,
    sortOrder: 0,
  },
];

describe("campos BOOLEAN (casillas de alteración)", () => {
  it("guarda true solo cuando está marcado; false y vacío no se guardan", () => {
    const { values, errors } = validateFieldValues(DEFS_GRANO, {
      brotado: "true",
      insectos: "No",
      olor: false,
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({ brotado: true, insectos: "No" });
  });

  it("acepta las formas habituales de sí/no y rechaza lo demás", () => {
    expect(validateFieldValues(DEFS_GRANO, { brotado: "sí" }).values.brotado).toBe(true);
    expect(validateFieldValues(DEFS_GRANO, { brotado: true }).values.brotado).toBe(true);
    expect(validateFieldValues(DEFS_GRANO, { brotado: "no" }).values.brotado).toBeUndefined();
    const { errors } = validateFieldValues(DEFS_GRANO, { brotado: "quizás" });
    expect(errors.map((e) => e.field)).toEqual(["fields.brotado"]);
  });
});

describe("condicionesDe (advertencia de la muestra)", () => {
  it("una casilla marcada cuenta con su etiqueta; sin marcar, no", () => {
    expect(condicionesDe(DEFS_GRANO, { brotado: true })).toEqual(["Brotado"]);
    expect(condicionesDe(DEFS_GRANO, { brotado: false })).toEqual([]);
    expect(condicionesDe(DEFS_GRANO, {})).toEqual([]);
  });

  it("en una lista cuentan solo los valores señalados", () => {
    expect(condicionesDe(DEFS_GRANO, { insectos: "No" })).toEqual([]);
    expect(condicionesDe(DEFS_GRANO, { insectos: "Vivos" })).toEqual(["Insectos: Vivos"]);
  });

  it("una lista sin valores señalados cuenta con cualquier valor no vacío", () => {
    expect(condicionesDe(DEFS_GRANO, { olor: "Poco" })).toEqual(["Olor: Poco"]);
    expect(condicionesDe(DEFS_GRANO, { olor: "" })).toEqual([]);
  });

  it("los campos que no son condición nunca alertan, y el orden es el del catálogo", () => {
    expect(condicionesDe(DEFS_GRANO, { empresa: "Soybean", olor: "Mucho", brotado: true })).toEqual([
      "Brotado",
      "Olor: Mucho",
    ]);
  });
});

describe("buildDisplayName", () => {
  it("una casilla marcada que participa del nombre aporta su etiqueta, no 'true'", () => {
    const defs: FieldDefLike[] = [{ ...DEFS_GRANO[0], inName: true }];
    const sampledAt = new Date("2026-09-07T13:30:00.000Z");
    expect(buildDisplayName("ACOPIO", sampledAt, defs, { brotado: true })).toBe(
      "Acopio · Brotado · 07/09 10:30",
    );
    expect(buildDisplayName("ACOPIO", sampledAt, defs, {})).toBe("Acopio · 07/09 10:30");
  });

  it("arma sitio · campos inName (con prefijo) · fecha/hora de planta", () => {
    // 13:30Z = 10:30 en Córdoba (UTC-3), sin importar la zona del proceso.
    const sampledAt = new Date("2026-09-07T13:30:00.000Z");
    const nombre = buildDisplayName("MOLINO", sampledAt, DEFS, {
      turno: "2° Mañana",
      producto: "3/0",
      lote: "4521",
    });
    expect(nombre).toBe("Molino · 3/0 · Lote 4521 · 07/09 10:30");
  });

  it("omite los campos inName sin valor", () => {
    const sampledAt = new Date("2026-09-07T13:30:00.000Z");
    expect(buildDisplayName("ACOPIO", sampledAt, DEFS, { producto: "Tapera" })).toBe(
      "Acopio · Tapera · 07/09 10:30",
    );
  });
});
