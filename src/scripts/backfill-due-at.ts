/**
 * Backfill del campo dueAt para tickets viejos creados antes del feat
 * de SLA. Calcula dueAt = createdAt + SLA(priority) y lo persiste.
 *
 * Uso:
 *   npm run script:backfill-due-at
 *
 * Idempotente: solo toca tickets con dueAt = null. Ejecutarlo varias
 * veces no hace daño.
 */

import { prisma } from "../lib/database";
import { calculateDueAt } from "../lib/sla";

async function main() {
  const targets = await prisma.ticket.findMany({
    where: { dueAt: null },
    select: { id: true, priority: true, createdAt: true, status: true },
  });

  if (targets.length === 0) {
    console.log("✓ No hay tickets con dueAt nulo. Nada que hacer.");
    return;
  }

  console.log(`Backfill: ${targets.length} ticket(s) con dueAt = null.`);

  let updated = 0;
  for (const t of targets) {
    const dueAt = calculateDueAt(t.priority, t.createdAt);
    await prisma.ticket.update({
      where: { id: t.id },
      data: { dueAt },
    });
    updated++;
    if (updated % 10 === 0) {
      console.log(`  ${updated}/${targets.length}…`);
    }
  }

  console.log(`✓ ${updated} ticket(s) actualizados con dueAt.`);
}

main()
  .catch((err) => {
    console.error("✗ Error en backfill:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
