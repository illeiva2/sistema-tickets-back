/**
 * Da de alta (o rota) una credencial de servicio a partir del HASH del secreto,
 * sin que el secreto pase nunca por acá.
 *
 *   npx tsx src/scripts/register-service-client.ts <slug> <scopes> <sha256-del-secreto>
 *
 * Ejemplo (colector de red de la planta):
 *   npx tsx src/scripts/register-service-client.ts red-colector-srvdatos network:ingest 3f2a…
 *
 * El secreto lo genera el instalador del colector en el propio servidor, lo
 * guarda como variable de máquina y muestra sólo su SHA-256. A diferencia de
 * create-lab-service-client.ts, este script nunca ve ni imprime un secreto.
 */
import { prisma } from "../lib/database";

const [slugArg, scopesArg, hashArg] = process.argv.slice(2);

async function main() {
  const slug = (slugArg ?? "").trim();
  const scopes = (scopesArg ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const secretHash = (hashArg ?? "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) {
    throw new Error(`Slug inválido: "${slug}". Solo minúsculas, números y guiones (3 a 61 caracteres).`);
  }
  if (scopes.length === 0) throw new Error("Falta al menos un scope (formato area:accion, p. ej. network:ingest)");
  for (const scope of scopes) {
    if (!/^[a-z]+:[a-z]+$/.test(scope)) throw new Error(`Scope inválido: "${scope}" (formato area:accion)`);
  }
  if (!/^[0-9a-f]{64}$/.test(secretHash)) {
    throw new Error("El tercer argumento tiene que ser el SHA-256 del secreto en hexadecimal (64 caracteres)");
  }

  const existing = await prisma.serviceClient.findUnique({ where: { slug } });
  const client = await prisma.serviceClient.upsert({
    where: { slug },
    create: { slug, secretHash, scopes, isActive: true },
    // Rotar limpia una revocación previa, igual que create-lab-service-client.ts.
    update: { secretHash, scopes, isActive: true, revokedAt: null },
  });

  console.log("");
  console.log(existing ? "Credencial ROTADA" : "Credencial REGISTRADA");
  console.log(`  slug   : ${client.slug}`);
  console.log(`  scopes : ${client.scopes.join(", ")}`);
  console.log(`  hash   : ${secretHash.slice(0, 12)}…`);
  console.log("");
  if (existing) {
    console.log("⚠ El secreto anterior dejó de servir: el próximo envío con el viejo da 401.");
    console.log("");
  }
}

main()
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
