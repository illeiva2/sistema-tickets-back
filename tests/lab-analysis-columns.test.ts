import { describe, it, expect } from "vitest";
import {
  ANALYSIS_COLUMNS,
  aggregateAnalyses,
  analysisKey,
  columnsFor,
} from "../src/lib/labAnalysisColumns";

// Agregación de los análisis de UNA muestra a un valor por columna. Es la regla
// que decide qué número ve comercio en la grilla, así que se prueba sola.

const lectura = (
  source: "NIR" | "FN" | "GLUTOMATIC",
  params: [string, number, boolean?, string?][],
) => ({
  source,
  params: params.map(([code, value, isImplausible = false, unit = null]) => ({
    code,
    value,
    isImplausible,
    unit,
  })),
});

describe("aggregateAnalyses", () => {
  it("promedia las lecturas plausibles del mismo equipo y parámetro (dos canales, una repetición)", () => {
    const r = aggregateAnalyses([
      lectura("FN", [["Falling Number", 340]]),
      lectura("FN", [["Falling Number", 360]]),
      lectura("NIR", [["Proteína DryBasis", 12.25, false, "%"]]),
    ]);
    expect(r.values[analysisKey("FN", "Falling Number")]).toBe(350);
    expect(r.values[analysisKey("NIR", "Proteína DryBasis")]).toBe(12.25);
    expect(r.counts).toEqual({ FN: 2, NIR: 1 });
    expect(r.implausible).toEqual([]);
    expect(r.units[analysisKey("NIR", "Proteína DryBasis")]).toBe("%");
  });

  it("deja afuera las lecturas fuera de calibración cuando hay una plausible", () => {
    const r = aggregateAnalyses([
      lectura("NIR", [["Humedad AsIs", 13.0]]),
      lectura("NIR", [["Humedad AsIs", 0.0, true]]),
    ]);
    expect(r.values[analysisKey("NIR", "Humedad AsIs")]).toBe(13);
    expect(r.implausible).toEqual([]);
  });

  it("si TODAS son dudosas, promedia igual y marca la clave: se señala, no se esconde", () => {
    const r = aggregateAnalyses([
      lectura("GLUTOMATIC", [["Gluten húmedo", 0, true]]),
      lectura("GLUTOMATIC", [["Gluten húmedo", 1, true]]),
    ]);
    const k = analysisKey("GLUTOMATIC", "Gluten húmedo");
    expect(r.values[k]).toBe(0.5);
    expect(r.implausible).toEqual([k]);
  });

  it("redondea a 3 decimales e ignora valores no finitos", () => {
    const r = aggregateAnalyses([
      lectura("NIR", [["Proteína DryBasis", 12.3333333], ["Cenizas DryBasis", Number.NaN]]),
    ]);
    expect(r.values[analysisKey("NIR", "Proteína DryBasis")]).toBe(12.333);
    expect(analysisKey("NIR", "Cenizas DryBasis") in r.values).toBe(false);
  });

  it("sin mediciones devuelve todo vacío", () => {
    expect(aggregateAnalyses([])).toEqual({ values: {}, implausible: [], counts: {}, units: {} });
  });
});

describe("columnsFor", () => {
  it("ofrece el catálogo completo aunque los datos no traigan nada", () => {
    const cols = columnsFor(new Map());
    expect(cols.map((c) => c.key)).toEqual(ANALYSIS_COLUMNS.map((c) => c.key));
  });

  it("agrega al final, etiquetada con su código, una clave que el catálogo no conoce", () => {
    const cols = columnsFor(
      new Map([
        [analysisKey("NIR", "Proteína DryBasis"), "%"],
        [analysisKey("SDMATIC", "Parámetro nuevo"), "u"],
      ]),
    );
    const extra = cols[cols.length - 1];
    expect(extra).toMatchObject({
      key: "SDMATIC|Parámetro nuevo",
      source: "SDMATIC",
      code: "Parámetro nuevo",
      label: "Parámetro nuevo",
      unit: "u",
      decimals: 2,
    });
    expect(cols.length).toBe(ANALYSIS_COLUMNS.length + 1);
  });

  it("toma la unidad vista en los datos cuando el catálogo no la fija", () => {
    const sinUnidad = ANALYSIS_COLUMNS.find((c) => !c.unit)!;
    const cols = columnsFor(new Map([[sinUnidad.key, "adim"]]));
    expect(cols.find((c) => c.key === sinUnidad.key)?.unit).toBe("adim");
  });
});
