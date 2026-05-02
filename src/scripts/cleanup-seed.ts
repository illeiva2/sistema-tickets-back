/**
 * Limpia datos creados por el seed: borra los usuarios USER y AGENT
 * de seed (NO los ADMIN), todos los tickets donde el requester o el
 * assignee sea uno de esos usuarios, y todo lo asociado (comentarios,
 * audit logs, attachments, notificaciones).
 *
 * Uso:
 *   npm run script:cleanup-seed
 *
 * Idempotente: si los usuarios seed ya no existen, sale sin hacer nada.
 *
 * Pre-prod: ejecutar antes de salir de beta para que los KPIs reflejen
 * actividad real.
 */

import { prisma } from "../lib/database";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Emails de los usuarios seed que se van a borrar (NO incluye admin).
const SEED_EMAILS_TO_DELETE = [
  "agente1@empresa.com",
  "agente2@empresa.com",
  "usuario1@empresa.com",
  "usuario2@empresa.com",
  "usuario3@empresa.com",
];

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { in: SEED_EMAILS_TO_DELETE } },
    select: { id: true, email: true, name: true, role: true },
  });

  if (users.length === 0) {
    console.log("✓ No hay usuarios seed para borrar. Nada que hacer.");
    return;
  }

  const userIds = users.map((u) => u.id);

  // Inventario antes de borrar.
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { requesterId: { in: userIds } },
        { assigneeId: { in: userIds } },
      ],
    },
    select: { id: true, ticketNumber: true, title: true },
  });
  const ticketIds = tickets.map((t) => t.id);

  const commentCount = await prisma.comment.count({
    where: { authorId: { in: userIds } },
  });
  const auditCount = await prisma.auditLog.count({
    where: { actorId: { in: userIds } },
  });

  // Reportar.
  console.log("\nVoy a borrar:");
  console.log(`  - ${users.length} usuario(s):`);
  for (const u of users) {
    console.log(`      · ${u.email} (${u.role}) — ${u.name}`);
  }
  console.log(
    `  - ${tickets.length} ticket(s) donde son requester o assignee`,
  );
  console.log(
    `  - ${commentCount} comentario(s) hechos por estos usuarios en otros tickets`,
  );
  console.log(`  - ${auditCount} entrada(s) de audit log con estos actores`);
  console.log(
    `  - notificaciones y preferencias asociadas (cascade automático)`,
  );

  // Confirmación interactiva (saltable con CLEANUP_CONFIRM=yes).
  if (process.env.CLEANUP_CONFIRM !== "yes") {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(
      "\n¿Confirmás la operación? Escribí 'borrar' para continuar: ",
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "borrar") {
      console.log("Operación cancelada. Nada se modificó.");
      return;
    }
  }

  // Transacción atómica.
  await prisma.$transaction(async (tx) => {
    // 1. AuditLogs cuyo actor es un user seed (puede ser de tickets que NO se borran).
    if (auditCount > 0) {
      await tx.auditLog.deleteMany({
        where: { actorId: { in: userIds } },
      });
    }

    // 2. Comments cuyo author es un user seed (puede ser en tickets que NO se borran).
    if (commentCount > 0) {
      await tx.comment.deleteMany({
        where: { authorId: { in: userIds } },
      });
    }

    // 3. Borrar tickets de los seed users (cascade Comment.ticketId,
    //    Attachment.ticketId).
    if (ticketIds.length > 0) {
      await tx.ticket.deleteMany({
        where: { id: { in: ticketIds } },
      });
    }

    // 4. Borrar users (cascade Notification.userId,
    //    NotificationPreferences.userId).
    await tx.user.deleteMany({
      where: { id: { in: userIds } },
    });
  });

  console.log("\n✓ Cleanup completado:");
  console.log(`  - ${users.length} user(s) borrados`);
  console.log(`  - ${tickets.length} ticket(s) borrados`);
  console.log(`  - ${commentCount} comment(s) en otros tickets borrados`);
  console.log(`  - ${auditCount} audit log(s) borrados`);
  console.log("  - El admin del seed (admin@empresa.com) NO fue tocado.");
}

main()
  .catch((err) => {
    console.error("✗ Error en cleanup:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
