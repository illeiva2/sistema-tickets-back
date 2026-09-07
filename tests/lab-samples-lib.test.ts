import { describe, it, expect } from "vitest";
import {
  accessionCheckDigit,
  buildDisplayName,
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

describe("buildDisplayName", () => {
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
