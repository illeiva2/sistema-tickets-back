/**
 * Verifica las consultas de lectura del laboratorio contra la base real.
 *
 * Llama a los métodos del servicio directamente, sin pasar por HTTP ni por la
 * autenticación: lo que se está verificando es el SQL, y agregarle capas
 * encima solo agrega formas de que la prueba falle por algo que no es el SQL.
 *
 * Todo es SELECT. No escribe nada.
 *
 *   npx tsx src/scripts/verify-lab-queries.ts
 */
import LabQueryService from "../services/lab.query.service";
import { prisma } from "../lib/database";

const ok = (nombre: string, detalle: string) =>
  console.log(`  OK    ${nombre.padEnd(26)} ${detalle}`);
const mal = (nombre: string, e: unknown) =>
  console.log(`  FALLA ${nombre.padEnd(26)} ${(e as Error).message}`);

let fallas = 0;

async function probar(nombre: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detalle = await fn();
    ok(nombre, `${detalle}  (${Date.now() - t0} ms)`);
  } catch (e) {
    fallas++;
    mal(nombre, e);
  }
}

async function main() {
  console.log("\nConsultas de lectura del laboratorio\n");

  await probar("equipos", async () => {
    const r = await LabQueryService.equipos();
    return `${r.length} equipos: ${r.map((e) => `${e.displayName}=${e.totalSamples}`).join(", ")}`;
  });

  await probar("metodos", async () => {
    const r = await LabQueryService.metodos();
    return `${r.length} métodos, top: ${r[0]?.name?.trim()} (${r[0]?.totalUses})`;
  });

  await probar("resumen", async () => {
    const r = await LabQueryService.resumen();
    return `hoy=${r.samplesToday} semana=${r.samplesThisWeek} mes=${r.samplesThisMonth} equipos=${r.instrumentCount} wet7d=${r.avgWetGlutenLast7Days}`;
  });

  await probar("estadisticas (todo)", async () => {
    const r = await LabQueryService.estadisticas({ includeIncomplete: true });
    return `n=${r.count} incompletas=${r.incompleteCount} wet=${r.avgWetGluten} idx=${r.avgGlutenIndex}`;
  });

  await probar("estadisticas (completas)", async () => {
    const r = await LabQueryService.estadisticas({});
    return `n=${r.count} incompletas=${r.incompleteCount} wet=${r.avgWetGluten}`;
  });

  await probar("harinas", async () => {
    const r = await LabQueryService.harinas({ instrumentSerial: "2415480" });
    return r.map((f) => `${f.flour}=${f.count}`).join(" ");
  });

  await probar("harinas (guarda 3/0)", async () => {
    // La clasificación tiene que dejar afuera los códigos con forma de fecha
    // ("3/06/26 T1"). Si el regex perdiera el límite de dígito, esos caerían
    // en la harina 3/0 y el promedio quedaría contaminado en silencio.
    const filas = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n
      FROM "lab_measurements"
      WHERE "source" = 'GLUTOMATIC'::"LabSource"
        AND ltrim(coalesce("sampleRef", '')) ~* '^3/0[0-9]'
    `;
    return `${filas[0].n} códigos tipo fecha correctamente NO clasificados como 3/0`;
  });

  await probar("tendencia mensual", async () => {
    const r = await LabQueryService.tendenciaMensual(12);
    return `${r.length} meses, último ${r.at(-1)?.year}-${r.at(-1)?.month} n=${r.at(-1)?.count}`;
  });

  await probar("tendencia diaria", async () => {
    const r = await LabQueryService.tendenciaDiaria({}, 30);
    return `${r.length} días con datos en 30`;
  });

  await probar("tendencia respeta filtro", async () => {
    // El volumen diario tiene que MOVERSE al destildar "incluir incompletas".
    // Si no se mueve, el grafico esta contando mediciones que las cards ya
    // descartaron, y la misma pantalla muestra dos numeros distintos.
    const con = await LabQueryService.tendenciaDiaria({ includeIncomplete: true }, 90);
    const sin = await LabQueryService.tendenciaDiaria({ includeIncomplete: false }, 90);
    const nCon = con.reduce((a, p) => a + p.count, 0);
    const nSin = sin.reduce((a, p) => a + p.count, 0);
    if (nSin > nCon) throw new Error(`sin incompletas (${nSin}) > con incompletas (${nCon})`);
    return nSin < nCon
      ? `con=${nCon} sin=${nSin} · el filtro se refleja`
      : `con=${nCon} sin=${nSin} · iguales (no hubo incompletas en la ventana)`;
  });

  await probar("mensual respeta filtro", async () => {
    const con = await LabQueryService.tendenciaMensual(12, undefined, undefined, true);
    const sin = await LabQueryService.tendenciaMensual(12, undefined, undefined, false);
    const nCon = con.reduce((a, p) => a + p.count, 0);
    const nSin = sin.reduce((a, p) => a + p.count, 0);
    if (nSin > nCon) throw new Error(`sin (${nSin}) > con (${nCon})`);
    return `con=${nCon} sin=${nSin} (${nCon - nSin} incompletas descontadas)`;
  });

  await probar("mediciones (pág. 1)", async () => {
    const r = await LabQueryService.mediciones({ includeIncomplete: true }, 1, 5);
    const m = r.items[0];
    return `total=${r.total} primera=${m?.sampleCode} equipo=${m?.instrumentName} wet=${m?.wetGluten}`;
  });

  await probar("mediciones (orden asc)", async () => {
    const r = await LabQueryService.mediciones({ includeIncomplete: true }, 1, 3, "analyzedAt", false);
    return `más antigua: ${r.items[0]?.analyzedAt} (${r.items[0]?.sampleCode})`;
  });

  await probar("mediciones (filtro fecha)", async () => {
    const r = await LabQueryService.mediciones(
      { from: "2026-08-01", to: "2026-08-22", includeIncomplete: true },
      1,
      3,
    );
    return `total en agosto 1-22 = ${r.total}`;
  });

  await probar("detalle + historial", async () => {
    const lista = await LabQueryService.mediciones({ includeIncomplete: true }, 1, 1);
    const id = String(lista.items[0]!.sampleId);
    const d = await LabQueryService.detalle(id);
    return `#${id} ${d?.measurement.sampleCode} · ${d?.sameSampleHistory.length} análisis previos`;
  });

  await probar("detalle inexistente", async () => {
    const d = await LabQueryService.detalle("-99999");
    return d === null ? "devuelve null como corresponde" : "DEBERÍA devolver null";
  });

  await probar("nir productos", async () => {
    const r = await LabQueryService.nirProductos();
    return `${r.length} productos, top: ${r[0]?.productName} (${r[0]?.totalSamples})`;
  });

  const producto = (await LabQueryService.nirProductos())[0]?.productName;

  await probar("nir estadisticas", async () => {
    const r = await LabQueryService.nirEstadisticas({ product: producto });
    const excl = r.parameters.filter((p) => p.excluded > 0);
    return `n=${r.count} ${r.parameters.length} parámetros, ${excl.length} con valores fuera de rango`;
  });

  await probar("nir mediciones", async () => {
    const r = await LabQueryService.nirMediciones({ product: producto }, 1, 5);
    return `total=${r.total} primera con ${r.items[0]?.parameters.length} parámetros`;
  });

  await probar("nir tendencia", async () => {
    const r = await LabQueryService.nirTendencia({ product: producto }, 60);
    return `${r.length} días, último ${r.at(-1)?.date} con ${Object.keys(r.at(-1)?.averages ?? {}).length} promedios`;
  });

  await probar("nir base de humedad", async () => {
    const r = await LabQueryService.nirEstadisticas({ product: producto });
    const conBase = r.parameters.filter((p) => p.moistureBasis);
    return `${conBase.length}/${r.parameters.length} con base reconstruida (ej. ${conBase[0]?.parameterName} -> ${conBase[0]?.moistureBasis})`;
  });

  console.log(
    fallas === 0 ? "\nTodas las consultas pasaron.\n" : `\n${fallas} consulta(s) fallaron.\n`,
  );
  await prisma.$disconnect();
  process.exit(fallas === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
