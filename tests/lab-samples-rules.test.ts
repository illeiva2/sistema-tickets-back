import { describe, it, expect } from "vitest";
import {
  condicionesDe,
  esVisible,
  pctKey,
  validateFieldValues,
  visibleWhenOf,
  type FieldDefLike,
} from "../src/lib/labSamples";

// Reglas del catálogo definidas con laboratorios y acopio (28-sep-2026):
// campos que aparecen según otro campo, formato de lote, porcentaje en las
// alteraciones y mayúsculas. Son las reglas que hacen que "Lote" se pida solo
// en los embolses sin tocar código, así que se prueban solas.

const def = (over: Partial<FieldDefLike> & Pick<FieldDefLike, "key" | "label" | "type">): FieldDefLike => ({
  required: false,
  options: null,
  inName: false,
  namePrefix: null,
  sortOrder: 0,
  ...over,
});

const INTERNA: FieldDefLike[] = [
  def({ key: "producto", label: "Producto", type: "SELECT", required: true, options: ["Trigo Sucio", "3/0", "3/0 Embolse", "Tapera Embolse"] }),
  def({ key: "origen_trigo", label: "Origen", type: "SELECT", options: ["Silo", "Mezcla"], visibleWhen: { field: "producto", values: ["Trigo Sucio"] } }),
  def({ key: "silo", label: "Silo", type: "TEXT", visibleWhen: { field: "origen_trigo", values: ["Silo"] }, uppercase: true }),
  def({ key: "acoplado_mezcla", label: "Acoplado", type: "TEXT", visibleWhen: { field: "origen_trigo", values: ["Mezcla"] } }),
  def({
    key: "lote",
    label: "Lote",
    type: "TEXT",
    required: true,
    visibleWhen: { field: "producto", values: ["3/0 Embolse", "Tapera Embolse"] },
    pattern: "^\\d{3}[A-Z]$",
    patternHint: "3 números y una letra, por ejemplo 123A",
    uppercase: true,
  }),
];

describe("visibleWhenOf / esVisible", () => {
  it("sanea la regla guardada como JSON y rechaza formas inválidas", () => {
    expect(visibleWhenOf({ visibleWhen: { field: "producto", values: ["A", 3, "B"] } })).toEqual({ field: "producto", values: ["A", "B"] });
    expect(visibleWhenOf({ visibleWhen: null })).toBeNull();
    expect(visibleWhenOf({ visibleWhen: { field: "producto", values: [] } })).toBeNull();
    expect(visibleWhenOf({ visibleWhen: "producto" })).toBeNull();
  });

  it("un campo sin regla siempre se pide; con regla, solo cuando el controlador vale una de las opciones", () => {
    const [producto, origen, , , lote] = INTERNA;
    expect(esVisible(producto, {}, INTERNA)).toBe(true);
    expect(esVisible(origen, { producto: "Trigo Sucio" }, INTERNA)).toBe(true);
    expect(esVisible(origen, { producto: "3/0" }, INTERNA)).toBe(false);
    expect(esVisible(lote, { producto: "3/0 Embolse" }, INTERNA)).toBe(true);
    expect(esVisible(lote, { producto: "3/0" }, INTERNA)).toBe(false);
  });

  it("sigue la cadena: Silo depende de Origen, que depende de Producto", () => {
    const silo = INTERNA[2];
    expect(esVisible(silo, { producto: "Trigo Sucio", origen_trigo: "Silo" }, INTERNA)).toBe(true);
    // Origen dice Silo pero el producto ya no es trigo sucio: Origen no está visible, Silo tampoco.
    expect(esVisible(silo, { producto: "3/0", origen_trigo: "Silo" }, INTERNA)).toBe(false);
    expect(esVisible(silo, { producto: "Trigo Sucio", origen_trigo: "Mezcla" }, INTERNA)).toBe(false);
  });

  it("una casilla como controlador compara contra \"true\"", () => {
    const defs = [
      def({ key: "mezcla", label: "Mezcla", type: "BOOLEAN" }),
      def({ key: "acoplado", label: "Acoplado", type: "TEXT", visibleWhen: { field: "mezcla", values: ["true"] } }),
    ];
    expect(esVisible(defs[1], { mezcla: true }, defs)).toBe(true);
    expect(esVisible(defs[1], { mezcla: "true" }, defs)).toBe(true);
    expect(esVisible(defs[1], {}, defs)).toBe(false);
  });

  it("un ciclo en el catálogo no cuelga: se corta y el campo queda oculto", () => {
    const defs = [
      def({ key: "a", label: "A", type: "TEXT", visibleWhen: { field: "b", values: ["x"] } }),
      def({ key: "b", label: "B", type: "TEXT", visibleWhen: { field: "a", values: ["x"] } }),
    ];
    expect(esVisible(defs[0], { a: "x", b: "x" }, defs)).toBe(false);
  });
});

describe("validateFieldValues con reglas", () => {
  it("no exige ni guarda un campo oculto: el lote que quedó de un producto anterior se descarta", () => {
    const r = validateFieldValues(INTERNA, { producto: "3/0", lote: "123A" });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ producto: "3/0" });
  });

  it("en un embolse exige el lote y valida el formato 123A, guardándolo en mayúsculas", () => {
    const falta = validateFieldValues(INTERNA, { producto: "3/0 Embolse" });
    expect(falta.errors).toEqual([{ field: "fields.lote", message: "Lote es obligatorio" }]);

    const mal = validateFieldValues(INTERNA, { producto: "3/0 Embolse", lote: "12A" });
    expect(mal.errors).toEqual([{ field: "fields.lote", message: "Lote: 3 números y una letra, por ejemplo 123A" }]);

    const bien = validateFieldValues(INTERNA, { producto: "Tapera Embolse", lote: " 123a " });
    expect(bien.errors).toEqual([]);
    expect(bien.values).toEqual({ producto: "Tapera Embolse", lote: "123A" });
  });

  it("trigo sucio: silo o mezcla, y solo se guarda el dato del origen elegido", () => {
    const r = validateFieldValues(INTERNA, {
      producto: "Trigo Sucio",
      origen_trigo: "Mezcla",
      silo: "s2",
      acoplado_mezcla: "23",
    });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ producto: "Trigo Sucio", origen_trigo: "Mezcla", acoplado_mezcla: "23" });
  });

  it("un patrón que no compila no bloquea el registro", () => {
    const defs = [def({ key: "x", label: "X", type: "TEXT", pattern: "([" })];
    const r = validateFieldValues(defs, { x: "lo que sea" });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ x: "lo que sea" });
  });

  it("una casilla con porcentaje guarda el % (con coma) bajo <key>_pct, solo si está marcada", () => {
    const defs = [def({ key: "picados", label: "Picados", type: "BOOLEAN", isCondition: true, withPercent: true })];
    const con = validateFieldValues(defs, { picados: true, picados_pct: "1,5" });
    expect(con.errors).toEqual([]);
    expect(con.values).toEqual({ picados: true, picados_pct: 1.5 });

    const sinMarcar = validateFieldValues(defs, { picados: false, picados_pct: "4" });
    expect(sinMarcar.errors).toEqual([]);
    expect(sinMarcar.values).toEqual({});

    const fuera = validateFieldValues(defs, { picados: true, picados_pct: "140" });
    expect(fuera.errors).toEqual([{ field: "fields.picados_pct", message: "Picados: el porcentaje debe ser un número entre 0 y 100" }]);

    // Sin withPercent, la clave _pct es desconocida.
    const sinPct = validateFieldValues([def({ key: "brotado", label: "Brotado", type: "BOOLEAN" })], { brotado: true, brotado_pct: "2" });
    expect(sinPct.errors[0]).toMatchObject({ field: "fields.brotado_pct" });
  });

  it("pctKey es la convención del porcentaje", () => {
    expect(pctKey("picados")).toBe("picados_pct");
  });
});

describe("condicionesDe con porcentaje", () => {
  it("la alteración lleva su porcentaje cuando lo tiene", () => {
    const defs = [
      def({ key: "picados", label: "Picados", type: "BOOLEAN", isCondition: true, withPercent: true }),
      def({ key: "brotado", label: "Brotado", type: "BOOLEAN", isCondition: true, withPercent: true }),
      def({ key: "olor", label: "Olor", type: "SELECT", isCondition: true, options: ["No", "Poco", "Mucho"], conditionValues: ["Poco", "Mucho"] }),
    ];
    expect(condicionesDe(defs, { picados: true, picados_pct: 1.5, brotado: true, olor: "Mucho" })).toEqual([
      "Picados 1,5 %",
      "Brotado",
      "Olor: Mucho",
    ]);
  });
});
