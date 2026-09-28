/**
 * Aplica al catálogo de campos lo definido con los laboratorios y acopio en la
 * reunión del 28-sep-2026. Idempotente: se puede correr las veces que haga falta.
 *
 *   npx tsx src/scripts/configurar-catalogo-2026-09.ts
 *
 * Interna de proceso: siempre Molino (M-); producto suma "Prueba"; Trigo Sucio
 * pide Silo o Mezcla (con silo o acoplado); los embolses piden Lote con formato
 * 123A; el resto solo fecha, turno, producto y notas.
 *
 * Recepción de grano: Empresa/Procedencia/Chofer con sugerencias; Documento A
 * (N° de CTG) o B (N° de ticket) en lugar de carta de porte; Patente en
 * mayúsculas; Equipo (Chasis/Acoplado/Tolva 1/Tolva 2/Batea) en lugar de
 * acoplado; cada alteración del grano pide su porcentaje.
 *
 * Lo cargado hasta hoy se conserva: los campos que dejan de pedirse solo se
 * desactivan, y sus valores siguen en la ficha.
 */
import { prisma } from "../lib/database";
import { optionsOf } from "../lib/labSamples";

type Datos = {
  label: string;
  type: "TEXT" | "NUMBER" | "SELECT" | "DATETIME" | "BOOLEAN";
  required?: boolean;
  options?: string[];
  inName?: boolean;
  namePrefix?: string | null;
  placeholder?: string | null;
  sortOrder?: number;
  isCondition?: boolean;
  visibleWhen?: { field: string; values: string[] } | null;
  pattern?: string | null;
  patternHint?: string | null;
  withPercent?: boolean;
  suggest?: boolean;
  uppercase?: boolean;
  isActive?: boolean;
};

const cambios: string[] = [];

async function campo(kindId: string, key: string, datos: Datos) {
  const { type, ...resto } = datos;
  const data = {
    ...resto,
    options: datos.options ?? undefined,
    visibleWhen: datos.visibleWhen === null ? undefined : datos.visibleWhen,
  };
  const existente = await prisma.labSampleFieldDef.findUnique({ where: { kindId_key: { kindId, key } } });
  if (existente) {
    await prisma.labSampleFieldDef.update({ where: { id: existente.id }, data });
    cambios.push(`actualizado ${key}`);
  } else {
    await prisma.labSampleFieldDef.create({ data: { kindId, key, type, ...data } });
    cambios.push(`creado ${key} (${type})`);
  }
}

async function main() {
  const interna = await prisma.labSampleKind.findUnique({ where: { code: "INTERNA" }, include: { fields: true } });
  const recepcion = await prisma.labSampleKind.findUnique({ where: { code: "RECEPCION" }, include: { fields: true } });
  if (!interna || !recepcion) throw new Error("Faltan los tipos INTERNA / RECEPCION en el catálogo");

  // ─── Muestra interna de proceso ───────────────────────────────────────────
  await prisma.labSampleKind.update({ where: { id: interna.id }, data: { defaultSite: "MOLINO", lockSite: true } });
  cambios.push("INTERNA: laboratorio fijo Molino");

  const producto = interna.fields.find((f) => f.key === "producto");
  if (producto) {
    const ops = optionsOf(producto);
    if (!ops.includes("Prueba")) {
      await prisma.labSampleFieldDef.update({ where: { id: producto.id }, data: { options: [...ops, "Prueba"] } });
      cambios.push('producto: opción "Prueba"');
    }
  }
  await campo(interna.id, "origen_trigo", {
    label: "Origen",
    type: "SELECT",
    options: ["Silo", "Mezcla"],
    visibleWhen: { field: "producto", values: ["Trigo Sucio"] },
    placeholder: "Silo o mezcla",
    sortOrder: 3,
  });
  await campo(interna.id, "silo", {
    label: "Silo",
    type: "TEXT",
    visibleWhen: { field: "origen_trigo", values: ["Silo"] },
    inName: true,
    namePrefix: "Silo ",
    uppercase: true,
    placeholder: "N° de silo",
    sortOrder: 4,
  });
  await campo(interna.id, "acoplado_mezcla", {
    label: "Acoplado",
    type: "TEXT",
    visibleWhen: { field: "origen_trigo", values: ["Mezcla"] },
    inName: true,
    namePrefix: "Mezcla acoplado ",
    uppercase: true,
    placeholder: "N° de acoplado de la mezcla",
    sortOrder: 5,
  });
  await campo(interna.id, "lote", {
    label: "Lote",
    type: "TEXT",
    visibleWhen: { field: "producto", values: ["3/0 Embolse", "4/0 Embolse", "Tapera Embolse"] },
    pattern: "^\\d{3}[A-Z]$",
    patternHint: "3 números y una letra, por ejemplo 123A",
    uppercase: true,
    inName: true,
    namePrefix: "Lote ",
    placeholder: "123A",
    sortOrder: 6,
  });

  // ─── Recepción de grano ───────────────────────────────────────────────────
  const r = recepcion.id;
  await campo(r, "empresa", { label: "Empresa", type: "TEXT", required: true, suggest: true, sortOrder: 1 });
  await campo(r, "procedencia", { label: "Procedencia", type: "TEXT", required: true, suggest: true, sortOrder: 2 });
  await campo(r, "silo", { label: "Silo", type: "TEXT", sortOrder: 3 });
  await campo(r, "guia", {
    label: "Documento",
    type: "SELECT",
    options: ["A", "B"],
    placeholder: "A = CTG · B = ticket",
    sortOrder: 4,
  });
  await campo(r, "ctg", {
    label: "N° de CTG",
    type: "TEXT",
    visibleWhen: { field: "guia", values: ["A"] },
    placeholder: "Número de CTG",
    sortOrder: 5,
  });
  await campo(r, "ticket", {
    label: "N° de ticket",
    type: "TEXT",
    visibleWhen: { field: "guia", values: ["B"] },
    placeholder: "Número de ticket",
    sortOrder: 6,
  });
  await campo(r, "carta_porte", { label: "Carta de porte", type: "TEXT", isActive: false });
  await campo(r, "chofer", { label: "Chofer", type: "TEXT", suggest: true, sortOrder: 7 });
  await campo(r, "patente", { label: "Patente", type: "TEXT", uppercase: true, placeholder: "AB123CD", sortOrder: 8 });
  await campo(r, "equipo", {
    label: "Equipo",
    type: "SELECT",
    options: ["Chasis", "Acoplado", "Tolva 1", "Tolva 2", "Batea"],
    sortOrder: 9,
  });
  await campo(r, "acoplado", { label: "Acoplado", type: "TEXT", isActive: false });

  // Alteraciones con porcentaje del escáner de granos (las casillas; insectos y olor son listas).
  for (const f of recepcion.fields) {
    if (f.type === "BOOLEAN" && f.isCondition && f.isActive && !f.withPercent) {
      await prisma.labSampleFieldDef.update({ where: { id: f.id }, data: { withPercent: true } });
      cambios.push(`${f.key}: con porcentaje`);
    }
  }

  console.log("Catálogo configurado:");
  for (const c of cambios) console.log("  -", c);
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
