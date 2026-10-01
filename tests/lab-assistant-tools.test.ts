import { vi, describe, it, beforeEach, expect } from "vitest";

vi.mock("../src/lib/database", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { prisma: mockDeep() };
});

import { ApiError } from "../src/lib/errors";
import { ANALYSIS_COLUMNS } from "../src/lib/labAnalysisColumns";
import LabReportService from "../src/services/lab.report.service";
import LabSamplesService from "../src/services/lab.samples.service";
import LabService from "../src/services/lab.service";
import { TOOLS, catalogoParaPrompt, executeTool } from "../src/services/lab.assistant.tools";

// Las herramientas son lo único que el modelo puede hacer: acá se prueba que
// traducen bien sus pedidos (fechas, laboratorio, agrupación) y que devuelven
// datos legibles (etiquetas, unidades, coma decimal), nunca códigos crudos.

const ahora = new Date("2026-09-11T13:25:00.000Z");

const KINDS = [
  {
    id: "k-rec",
    code: "RECEPCION",
    name: "Recepción de grano",
    defaultSite: "ACOPIO",
    fields: [
      { key: "empresa", label: "Empresa", type: "TEXT", isCondition: false },
      { key: "patente", label: "Patente", type: "TEXT", isCondition: false },
      { key: "brotado", label: "Brotado", type: "BOOLEAN", isCondition: true },
    ],
  },
];

const fila = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  accession: "A-0002-3",
  site: "ACOPIO",
  seq: 2,
  kindId: "k-rec",
  sampledAt: ahora,
  displayName: "Acopio · Los Álamos",
  fields: { empresa: "Los Álamos", patente: "AB123CD", brotado: true, vacio: "" },
  notes: null,
  kind: { id: "k-rec", code: "RECEPCION", name: "Recepción de grano" },
  createdBy: { id: "u", name: "Op" },
  conditions: ["Brotado"],
  analyses: { NIR: 1, FN: 2 },
  values: { "NIR|Proteína DryBasis": 12.345, "FN|Falling Number": 60, "SDMATIC|Parámetro nuevo": 7.5 },
  implausible: ["FN|Falling Number"],
  ...over,
});

const grilla = (items: ReturnType<typeof fila>[], over: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  limit: 500,
  truncated: false,
  columns: [
    ...ANALYSIS_COLUMNS,
    { key: "SDMATIC|Parámetro nuevo", source: "SDMATIC", code: "Parámetro nuevo", label: "Parámetro nuevo", unit: "u", decimals: 2 },
  ],
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LabSamplesService, "kinds").mockResolvedValue(KINDS as any);
});

describe("definiciones", () => {
  it("cada herramienta tiene nombre, descripción y esquema de objeto", () => {
    expect(TOOLS.map((t) => t.function.name)).toEqual([
      "buscar_muestras",
      "ficha_muestra",
      "resumen_analisis",
      "reporte_diario",
      "estado_equipos",
    ]);
    for (const t of TOOLS) {
      expect(t.type).toBe("function");
      expect(t.function.description.length).toBeGreaterThan(20);
      expect(t.function.parameters).toMatchObject({ type: "object" });
    }
  });

  it("el catálogo para el prompt nombra tipos, claves de campo y análisis con unidad", async () => {
    const c = await catalogoParaPrompt();
    expect(c).toContain("Recepción de grano (Acopio)");
    expect(c).toContain("Empresa [empresa]");
    expect(c).toContain("Brotado [brotado] (alteración)");
    expect(c).toContain("Proteína (NIR, b.s.) (%)");
  });
});

describe("buscar_muestras", () => {
  it("traduce filtros, etiqueta la ficha y formatea los análisis con unidad, coma y marca de dudoso", async () => {
    const grid = vi.spyOn(LabSamplesService, "grid").mockResolvedValue(grilla([fila()]) as any);

    const r = await executeTool("buscar_muestras", { desde: "2026-09-01", laboratorio: "acopio", texto: "Álamos", limite: 5 });

    expect(r.ok).toBe(true);
    expect(grid).toHaveBeenCalledWith({ from: "2026-09-01", to: undefined, site: "ACOPIO", q: "Álamos" }, 5);
    expect(r.summary).toBe('buscar_muestras: 1 muestra (2026-09-01 a hoy, Acopio, "Álamos")');
    const d = r.data as any;
    expect(d.devueltas).toBe(1);
    const m = d.muestras[0];
    expect(m).toMatchObject({ accesion: "A-0002-3", laboratorio: "Acopio", tipo: "Recepción de grano", alteraciones: ["Brotado"] });
    // Ficha con etiquetas del catálogo, casillas como "Sí", vacíos afuera.
    expect(m.ficha).toEqual({ Empresa: "Los Álamos", Patente: "AB123CD", Brotado: "Sí" });
    expect(m.analisis["Proteína (NIR, b.s.)"]).toBe("12,3 %");
    expect(m.analisis["Falling Number"]).toBe("60 s (dudoso: fuera de calibración)");
    // Un código que el catálogo no conoce usa la etiqueta/unidad que vino en la grilla.
    expect(m.analisis["Parámetro nuevo"]).toBe("7,50 u");
    expect(m.fecha).toBe("11/09/2026, 10:25");
  });

  it("con solo_con_alteraciones trae de más y filtra acá", async () => {
    const grid = vi
      .spyOn(LabSamplesService, "grid")
      .mockResolvedValue(grilla([fila(), fila({ id: "s2", accession: "A-0003-1", conditions: [] })]) as any);

    const r = await executeTool("buscar_muestras", { solo_con_alteraciones: true, limite: 10 });

    expect(grid.mock.calls[0][1]).toBe(200);
    expect((r.data as any).muestras.map((m: any) => m.accesion)).toEqual(["A-0002-3"]);
    expect(r.summary).toContain("con alteraciones");
  });

  it("con solo_rechazados filtra en la consulta y cada fila dice el motivo, quién y cuándo; sin rechazo no ocupa lugar", async () => {
    const rechazadaEl = new Date("2026-10-01T13:05:00.000Z");
    const grid = vi.spyOn(LabSamplesService, "grid").mockResolvedValue(
      grilla([
        fila({ rejectedAt: rechazadaEl, rejectedReason: "Olor fuerte", rejectedBy: { id: "u", name: "Ana" } }),
        fila({ id: "s2", accession: "A-0003-1", rejectedAt: null, rejectedReason: null }),
      ]) as any,
    );

    const r = await executeTool("buscar_muestras", { solo_rechazados: true, limite: 10 });

    expect(grid.mock.calls[0][0]).toMatchObject({ rejected: true });
    const muestras = (r.data as any).muestras;
    expect(muestras[0].rechazo).toBe("RECHAZADO: Olor fuerte (marcó Ana, 01/10/2026, 10:05)");
    expect(muestras[1].rechazo).toBeUndefined();
    expect(r.summary).toContain("rechazados");
  });

  it("una fecha mal formada vuelve como error para que el modelo se corrija, sin consultar", async () => {
    const grid = vi.spyOn(LabSamplesService, "grid");
    const r = await executeTool("buscar_muestras", { desde: "1/9/2026" });
    expect(r.ok).toBe(false);
    expect((r.data as any).error).toMatch(/YYYY-MM-DD/);
    expect(grid).not.toHaveBeenCalled();
  });

  it("un laboratorio inexistente también", async () => {
    const r = await executeTool("buscar_muestras", { laboratorio: "planta" });
    expect(r.ok).toBe(false);
    expect((r.data as any).error).toMatch(/MOLINO o ACOPIO/);
  });
});

describe("resumen_analisis", () => {
  const filas = [
    fila({ id: "a", accession: "A-0001-0", fields: { empresa: "Los Álamos" }, values: { "NIR|Proteína DryBasis": 12.0 }, implausible: [] }),
    fila({ id: "b", accession: "A-0002-3", fields: { empresa: "Los Álamos" }, values: { "NIR|Proteína DryBasis": 13.0 }, implausible: [] }),
    fila({ id: "c", accession: "A-0003-1", fields: { empresa: "El Trigal" }, values: { "NIR|Proteína DryBasis": 9.0 }, implausible: ["NIR|Proteína DryBasis"] }),
    fila({ id: "d", accession: "A-0004-9", fields: {}, values: { "NIR|Proteína DryBasis": 11.0 }, implausible: [] }),
  ];

  it("agrupa por un campo de la ficha con n, promedio, mínimo y máximo (con accesión), excluyendo dudosos", async () => {
    vi.spyOn(LabSamplesService, "grid").mockResolvedValue(grilla(filas) as any);

    const r = await executeTool("resumen_analisis", { agrupar_por: "empresa", desde: "2026-09-01", hasta: "2026-09-11" });

    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.muestras).toBe(4);
    expect(d.agrupado_por).toBe("empresa");
    expect(d.grupos.map((g: any) => g.grupo)).toEqual(["Los Álamos", "(sin dato)", "El Trigal"]);
    const alamos = d.grupos[0];
    expect(alamos.muestras).toBe(2);
    expect(alamos.analisis["Proteína (NIR, b.s.)"]).toEqual({
      n: 2,
      promedio: "12,5 %",
      minimo: "12,0 % (A-0001-0)",
      maximo: "13,0 % (A-0002-3)",
    });
    // El Trigal solo tenía una lectura dudosa: no cuenta para el promedio, pero se informa.
    const trigal = d.grupos[2];
    expect(trigal.analisis["Proteína (NIR, b.s.)"]).toBeUndefined();
    expect(trigal.muestras).toBe(1);
  });

  it("sin agrupar devuelve un solo total, y por día ordena cronológicamente", async () => {
    vi.spyOn(LabSamplesService, "grid").mockResolvedValue(grilla(filas) as any);

    const total = await executeTool("resumen_analisis", {});
    expect((total.data as any).grupos.map((g: any) => g.grupo)).toEqual(["Total"]);
    expect((total.data as any).grupos[0].analisis["Proteína (NIR, b.s.)"].n).toBe(3);

    const porDia = await executeTool("resumen_analisis", { agrupar_por: "dia" });
    expect((porDia.data as any).grupos[0].grupo).toBe("2026-09-11");
  });

  it("avisa cuando la grilla vino truncada", async () => {
    vi.spyOn(LabSamplesService, "grid").mockResolvedValue(grilla(filas, { truncated: true, total: 1500, limit: 1000 }) as any);
    const r = await executeTool("resumen_analisis", {});
    expect((r.data as any).aviso).toMatch(/1000 muestras más recientes de 1500/);
  });
});

describe("ficha_muestra", () => {
  it("devuelve la ficha con cada medición formateada", async () => {
    vi.spyOn(LabSamplesService, "getByAccession").mockResolvedValue({
      ...fila(),
      notes: "muestra de camión",
      measurements: [
        {
          id: "m1",
          source: "NIR",
          sourceId: "1",
          instrumentSerial: null,
          instrumentName: null,
          productCode: "Trigo",
          sampleRef: "A-0002-3",
          analyzedAt: ahora,
          params: [
            { code: "Proteína DryBasis", value: 12.34, unit: "%", isImplausible: false },
            { code: "Código raro", value: 1.5, unit: "x", isImplausible: true },
          ],
        },
      ],
    } as any);

    const r = await executeTool("ficha_muestra", { accesion: "a 0002 3" });

    expect(r.ok).toBe(true);
    expect(LabSamplesService.getByAccession).toHaveBeenCalledWith("a 0002 3");
    const d = r.data as any;
    expect(d.notas).toBe("muestra de camión");
    expect(d.analisis[0]).toMatchObject({ equipo: "NIR", producto_segun_equipo: "Trigo" });
    expect(d.analisis[0].valores).toEqual({
      "Proteína (NIR, b.s.)": "12,3 %",
      "Código raro": "1,50 x (dudoso: fuera de calibración)",
    });
  });

  it("una accesión inválida (400 del service) o inexistente vuelve como error para el modelo", async () => {
    vi.spyOn(LabSamplesService, "getByAccession").mockRejectedValueOnce(
      new ApiError("INVALID_ACCESSION", "Accesión inválida: revisá el número y el dígito verificador", 400),
    );
    const invalida = await executeTool("ficha_muestra", { accesion: "M-0012-9" });
    expect(invalida.ok).toBe(false);
    expect((invalida.data as any).error).toMatch(/dígito verificador/);

    vi.spyOn(LabSamplesService, "getByAccession").mockResolvedValueOnce(null);
    const inexistente = await executeTool("ficha_muestra", { accesion: "M-0012-4" });
    expect(inexistente.ok).toBe(false);
    expect((inexistente.data as any).error).toMatch(/no existe/);

    expect((await executeTool("ficha_muestra", {})).ok).toBe(false);
  });

  it("una falla real del sistema sí se propaga", async () => {
    vi.spyOn(LabSamplesService, "getByAccession").mockRejectedValue(new Error("db caída"));
    await expect(executeTool("ficha_muestra", { accesion: "M-0012-4" })).rejects.toThrow("db caída");
  });
});

describe("reporte_diario y estado_equipos", () => {
  it("el reporte diario etiqueta las columnas y formatea los promedios", async () => {
    vi.spyOn(LabReportService, "diario").mockResolvedValue({
      date: "2026-09-10",
      from: new Date("2026-09-10T01:00:00Z"),
      to: new Date("2026-09-11T01:00:00Z"),
      turnos: [],
      columns: [
        { key: "NIR|Proteína DryBasis", code: "Proteína DryBasis", source: "NIR", label: "NIR", group: "% Proteínas", section: "fq", unit: "%", decimals: 1, manual: false },
      ],
      rows: [
        {
          turno: "2° Mañana (07:00–14:00)",
          producto: "3/0",
          orden: 4,
          sample: { id: "s1", accession: "M-0001-3", sampledAt: new Date("2026-09-10T10:00:00Z"), displayName: "Molino · 3/0" },
          hora: "07:00",
          lote: null,
          sinMuestra: false,
          measurements: 4,
          values: { "NIR|Proteína DryBasis": 11.26 },
          implausible: [],
          noLiga: true,
        },
        // Un hueco de la planilla: no le sirve al modelo, no viaja.
        { turno: "2° Mañana (07:00–14:00)", producto: "4/0", orden: 5, sample: null, hora: null, lote: null, sinMuestra: false, measurements: 0, values: {}, implausible: [], noLiga: false },
      ],
      totalMeasurements: 4,
      totalSamples: 1,
    } as any);

    const r = await executeTool("reporte_diario", { fecha: "2026-09-10" });

    expect(LabReportService.diario).toHaveBeenCalledWith("2026-09-10");
    expect(r.summary).toBe("reporte_diario: 2026-09-10 (2 filas, 4 mediciones)");
    expect((r.data as any).filas).toHaveLength(1);
    expect((r.data as any).filas[0]).toMatchObject({
      producto: "3/0",
      accesion: "M-0001-3",
      hora: "07:00",
      gluten: "NO LIGA (el Glutomatic no formó gluten)",
      valores: { "% Proteínas NIR": "11,3 %" },
    });

    expect((await executeTool("reporte_diario", { fecha: "ayer" })).ok).toBe(false);
  });

  it("el estado de equipos traduce cada origen a su nombre y fechas legibles", async () => {
    vi.spyOn(LabService, "getHealth").mockResolvedValue({
      overall: "OK",
      sources: [
        {
          source: "ALVEOLAB",
          state: "OK",
          sourceQuiet: true,
          lastHeartbeatAt: ahora,
          lastSourceAnalyzedAt: new Date("2026-09-10T19:20:43Z"),
          lastErrorCode: null,
          measurements: 3800,
        },
      ],
    } as any);

    const r = await executeTool("estado_equipos", {});

    expect(r.ok).toBe(true);
    expect((r.data as any).equipos[0]).toEqual({
      equipo: "Alveógrafo (AlveoLab)",
      estado: "OK",
      sin_mediciones_nuevas: true,
      ultimo_analisis: "10/09/2026, 16:20",
      ultima_senal_del_agente: "11/09/2026, 10:25",
      mediciones_totales: 3800,
      error: null,
    });
  });

  it("una herramienta desconocida vuelve como error listando las disponibles", async () => {
    const r = await executeTool("borrar_todo", {});
    expect(r.ok).toBe(false);
    expect((r.data as any).error).toContain("buscar_muestras");
  });
});
