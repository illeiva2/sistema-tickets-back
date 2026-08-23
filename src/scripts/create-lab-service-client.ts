/**
 * Da de alta (o rota) la credencial del agente que empuja las mediciones del
 * laboratorio desde el molino.
 *
 *   npx tsx src/scripts/create-lab-service-client.ts [slug]
 *
 * El secreto se imprime UNA sola vez y no se guarda en ningún lado: en la base
 * queda solo su hash. Si se pierde, se vuelve a correr este script y se rota.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../lib/database";

const DEFAULT_SLUG = "glutenlab-pusher-srvdatos";
const SCOPES = ["lab:ingest"];

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function main() {
  const slug = (process.argv[2] ?? DEFAULT_SLUG).trim();

  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) {
    throw new Error(
      `Slug inválido: "${slug}". Solo minúsculas, números y guiones (3 a 61 caracteres).`,
    );
  }

  // 32 bytes en base64url = 43 caracteres, igual que los secretos de agente.
  const secret = randomBytes(32).toString("base64url");
  const secretHash = sha256(secret);

  const existing = await prisma.serviceClient.findUnique({ where: { slug } });

  const client = await prisma.serviceClient.upsert({
    where: { slug },
    create: { slug, secretHash, scopes: SCOPES, isActive: true },
    // Rotar limpia una revocación previa: si alguien lo dio de baja y ahora lo
    // vuelve a habilitar, tiene que quedar utilizable.
    update: { secretHash, scopes: SCOPES, isActive: true, revokedAt: null },
  });

  console.log("");
  console.log(existing ? "Credencial ROTADA" : "Credencial CREADA");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  slug   : ${client.slug}`);
  console.log(`  scopes : ${client.scopes.join(", ")}`);
  console.log(`  secreto: ${secret}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("");
  console.log("Guardalo ahora: no se puede volver a mostrar. En el servidor del");
  console.log("molino va como variable de entorno del CloudPusher:");
  console.log("");
  console.log(`  GLUTENLAB_CLIENT_SLUG=${client.slug}`);
  console.log("  GLUTENLAB_CLIENT_SECRET=<el secreto de arriba>");
  console.log("");
  if (existing) {
    console.log("⚠ El secreto anterior dejó de servir: actualizá el agente o");
    console.log("  el próximo push va a fallar con 401.");
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
