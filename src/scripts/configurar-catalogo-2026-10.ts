/**
 * Catálogo de campos: lo que pidieron acopio y comercio el 1-oct-2026 en la
 * cadena "Registro de análisis equipos de laboratorio". Idempotente: se puede
 * correr las veces que haga falta.
 *
 *   npx tsx src/scripts/configurar-catalogo-2026-10.ts
 *   npx tsx src/scripts/configurar-catalogo-2026-10.ts --clasificar-historico
 *
 * Recepción de grano: "Tipo de ingreso" (Camión / Muestra del cliente). Arranca
 * en Camión (el caso común no exige ningún clic) y se ofrece como filtro en
 * Muestras y en Análisis, que es lo que comercio necesita para separar las
 * muestras que trae un cliente en una bolsa de los camiones que llegan a la
 * descarga. Hasta hoy eso se anotaba en las notas con la leyenda "(MUESTRA)".
 * Los datos del camión (silo, documento con su CTG o ticket, chofer, patente y
 * equipo) se piden solo cuando es un camión; empresa, procedencia y las
 * alteraciones del grano, siempre.
 *
 * Interna de proceso: con Trigo Sucio y origen Silo, además del número de silo
 * se pide el acoplado (como en Mezcla, que sigue pidiendo solo el acoplado).
 *
 * --clasificar-historico: a las recepciones ya cargadas que no tienen tipo de
 * ingreso les pone "Muestra del cliente" si las notas llevan la leyenda
 * "(muestra)" (o mencionan "muestra" y no hay patente), y "Camión" si tienen
 * patente. Las demás quedan sin tipo y se completan al editar la ficha. Sin la
 * opción, el script no toca ninguna muestra.
 */
import { prisma } from "../lib/database";

type Datos = {
  label?: string;
  type?: "TEXT" | "NUMBER" | "SELECT" | "DATETIME" | "BOOLEAN";
  required?: boolean;
  options?: string[];
  inName?: boolean;
  namePrefix?: string | null;
  placeholder?: string | null;
  sortOrder?: number;
  visibleWhen?: { field: string; values: string[] } | null;
  uppercase?: boolean;
  defaultValue?: string | null;
  filterable?: boolean;
  isActive?: boolean;
};

const CAMION = "Camión";
const CLIENTE = "Muestra del cliente";

const cambios: string[] = [];

/** Crea el campo si no existe (entonces label y type son obligatorios) o actualiza solo lo que se pasa. */
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
    return;
  }
  if (!type || !datos.label) throw new Error(`El campo ${key} no existe y faltan label/type para crearlo`);
  await prisma.labSampleFieldDef.create({ data: { kindId, key, type, label: datos.label, ...data } });
  cambios.push(`creado ${key} (${type})`);
}

async function clasificarHistorico(kindId: string) {
  const filas = await prisma.labSample.findMany({
    where: { kindId, deletedAt: null },
    select: { id: true, accession: true, fields: true, notes: true },
    orderBy: { sampledAt: "asc" },
  });
  const cliente: { id: string; accession: string; fields: Record<string, unknown> }[] = [];
  const camion: { id: string; fields: Record<string, unknown> }[] = [];
  let yaClasificadas = 0;
  let sinTipo = 0;
  for (const s of filas) {
    const f = (s.fields ?? {}) as Record<string, unknown>;
    if (typeof f.tipo_ingreso === "string" && f.tipo_ingreso.trim() !== "") {
      yaClasificadas++;
      continue;
    }
    const notas = s.notes ?? "";
    const conPatente = typeof f.patente === "string" && f.patente.trim() !== "";
    // La leyenda explícita manda; "muestra" suelto solo cuenta si tampoco hay camión.
    const esCliente = /\(\s*muestra\s*\)/i.test(notas) || (/\bmuestra\b/i.test(notas) && !conPatente);
    if (esCliente) cliente.push({ id: s.id, accession: s.accession, fields: f });
    else if (conPatente) camion.push({ id: s.id, fields: f });
    else sinTipo++;
  }

  const lote = [
    ...cliente.map((s) => ({ id: s.id, fields: { ...s.fields, tipo_ingreso: CLIENTE } })),
    ...camion.map((s) => ({ id: s.id, fields: { ...s.fields, tipo_ingreso: CAMION } })),
  ];
  for (let i = 0; i < lote.length; i += 100) {
    await prisma.$transaction(
      lote
        .slice(i, i + 100)
        .map((s) => prisma.labSample.update({ where: { id: s.id }, data: { fields: s.fields } })),
    );
  }

  console.log(`Histórico de recepciones: ${filas.length} muestras.`);
  console.log(`  - ya tenían tipo: ${yaClasificadas}`);
  console.log(`  - marcadas "${CAMION}" (tienen patente): ${camion.length}`);
  console.log(`  - marcadas "${CLIENTE}" (notas con "muestra"): ${cliente.length}`);
  for (const s of cliente) console.log(`      ${s.accession}`);
  console.log(`  - sin tipo (sin patente ni leyenda; se completan al editar): ${sinTipo}`);
}

async function main() {
  const clasificar = process.argv.includes("--clasificar-historico");
  const interna = await prisma.labSampleKind.findUnique({ where: { code: "INTERNA" } });
  const recepcion = await prisma.labSampleKind.findUnique({ where: { code: "RECEPCION" } });
  if (!interna || !recepcion) throw new Error("Faltan los tipos INTERNA / RECEPCION en el catálogo");

  // ─── Recepción de grano: camión o muestra del cliente ────────────────────
  const r = recepcion.id;
  await campo(r, "tipo_ingreso", {
    label: "Tipo de ingreso",
    type: "SELECT",
    options: [CAMION, CLIENTE],
    required: true,
    defaultValue: CAMION,
    filterable: true,
    placeholder: "Camión en la descarga o muestra que trae el cliente",
    sortOrder: 0,
  });
  const soloCamion = { field: "tipo_ingreso", values: [CAMION] };
  // Documento arrastra a CTG y ticket (dependen de él); empresa, procedencia y
  // las alteraciones se piden siempre.
  for (const key of ["silo", "guia", "chofer", "patente", "equipo"]) {
    await campo(r, key, { visibleWhen: soloCamion });
  }

  // ─── Interna de proceso: Silo pide silo + acoplado; Mezcla, solo acoplado ─
  await campo(interna.id, "acoplado_silo", {
    label: "Acoplado",
    type: "TEXT",
    visibleWhen: { field: "origen_trigo", values: ["Silo"] },
    inName: true,
    namePrefix: "Acoplado ",
    uppercase: true,
    placeholder: "N° de acoplado",
    sortOrder: 5,
  });
  // Mismo nombre en la vista Análisis sería ambiguo: una columna por origen.
  await campo(interna.id, "acoplado_mezcla", { label: "Acoplado (mezcla)", sortOrder: 6 });
  await campo(interna.id, "lote", { sortOrder: 7 });

  console.log("Catálogo configurado:");
  for (const c of cambios) console.log("  -", c);

  if (clasificar) await clasificarHistorico(r);
  else console.log("Las recepciones ya cargadas quedan sin tipo de ingreso (correr con --clasificar-historico para completarlas).");
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
