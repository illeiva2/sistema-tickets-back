import { PrismaClient, UserRole, TicketStatus, TicketPriority } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed completo de la base de datos...');

  // Limpiar base de datos existente
  console.log('🗑️ Limpiando datos existentes...');
  await prisma.auditLog.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.user.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.notificationPreferences.deleteMany();

  console.log('✅ Base de datos limpiada');

  // Crear usuarios
  console.log('👥 Creando usuarios...');
  
  const passwordHash = await bcrypt.hash('password123', 10);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@empresa.com',
      passwordHash,
      name: 'Administrador del Sistema',
      role: UserRole.ADMIN
    }
  });

  const agent1 = await prisma.user.create({
    data: {
      email: 'agente1@empresa.com',
      passwordHash,
      name: 'María González',
      role: UserRole.AGENT
    }
  });

  const agent2 = await prisma.user.create({
    data: {
      email: 'agente2@empresa.com',
      passwordHash,
      name: 'Carlos Rodríguez',
      role: UserRole.AGENT
    }
  });

  const user1 = await prisma.user.create({
    data: {
      email: 'usuario1@empresa.com',
      passwordHash,
      name: 'Ana Martínez',
      role: UserRole.USER
    }
  });

  const user2 = await prisma.user.create({
    data: {
      email: 'usuario2@empresa.com',
      passwordHash,
      name: 'Luis Pérez',
      role: UserRole.USER
    }
  });

  const user3 = await prisma.user.create({
    data: {
      email: 'usuario3@empresa.com',
      passwordHash,
      name: 'Sofia López',
      role: UserRole.USER
    }
  });

  console.log('✅ Usuarios creados');

  // Crear tickets
  console.log('🎫 Creando tickets...');

  const tickets = await Promise.all([
    // Ticket 1: Problema de login
    prisma.ticket.create({
      data: {
        title: 'Error al iniciar sesión en el sistema',
        description: 'No puedo acceder a mi cuenta desde ayer. Aparece un error de credenciales inválidas. He intentado cambiar la contraseña pero sigue sin funcionar.',
        priority: TicketPriority.HIGH,
        status: TicketStatus.OPEN,
        requesterId: user1.id
      }
    }),

    // Ticket 2: Problema con impresora
    prisma.ticket.create({
      data: {
        title: 'Impresora del departamento de contabilidad no funciona',
        description: 'La impresora HP LaserJet del departamento de contabilidad no está funcionando correctamente. Muestra un error de "Paper Jam" pero no hay papel atascado.',
        priority: TicketPriority.MEDIUM,
        status: TicketStatus.IN_PROGRESS,
        requesterId: user2.id,
        assigneeId: agent1.id
      }
    }),

    // Ticket 3: Solicitud de software
    prisma.ticket.create({
      data: {
        title: 'Necesito instalar Adobe Photoshop',
        description: 'Soy diseñador gráfico y necesito Adobe Photoshop instalado en mi computadora para trabajar en los proyectos de marketing. ¿Pueden instalarlo?',
        priority: TicketPriority.LOW,
        status: TicketStatus.RESOLVED,
        requesterId: user3.id,
        assigneeId: agent2.id,
        closedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 día atrás
      }
    }),

    // Ticket 4: Internet lento
    prisma.ticket.create({
      data: {
        title: 'Conexión a internet muy lenta en todo el edificio',
        description: 'La conexión a internet está extremadamente lenta en todo el edificio desde esta mañana. Es imposible trabajar con esta velocidad.',
        priority: TicketPriority.URGENT,
        status: TicketStatus.OPEN,
        requesterId: user1.id
      }
    }),

    // Ticket 5: Problema con email
    prisma.ticket.create({
      data: {
        title: 'No puedo enviar correos electrónicos desde Outlook',
        description: 'Outlook me da un error cuando intento enviar emails. Dice "Error de autenticación SMTP". He verificado mi contraseña y está correcta.',
        priority: TicketPriority.HIGH,
        status: TicketStatus.IN_PROGRESS,
        requesterId: user2.id,
        assigneeId: agent1.id
      }
    }),

    // Ticket 6: Actualización de antivirus
    prisma.ticket.create({
      data: {
        title: 'Antivirus necesita ser actualizado',
        description: 'Mi antivirus (McAfee) muestra que necesita ser actualizado desde hace varios días. ¿Pueden actualizarlo?',
        priority: TicketPriority.MEDIUM,
        status: TicketStatus.IN_PROGRESS,
        requesterId: user3.id,
        assigneeId: agent2.id
      }
    }),

    // Ticket 7: Proyector de sala de conferencias
    prisma.ticket.create({
      data: {
        title: 'Proyector de la sala de conferencias no se conecta',
        description: 'El proyector de la sala de conferencias principal no se conecta correctamente a mi laptop. He probado con diferentes cables HDMI.',
        priority: TicketPriority.MEDIUM,
        status: TicketStatus.RESOLVED,
        requesterId: user1.id,
        assigneeId: agent1.id,
        closedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // 2 días atrás
      }
    }),

    // Ticket 8: Acceso a carpeta compartida
    prisma.ticket.create({
      data: {
        title: 'Solicitud de acceso a carpeta compartida del proyecto X',
        description: 'Necesito acceso a la carpeta compartida del proyecto X que está en el servidor. Soy parte del equipo del proyecto.',
        priority: TicketPriority.LOW,
        status: TicketStatus.CLOSED,
        requesterId: user2.id,
        assigneeId: agent2.id,
        closedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // 3 días atrás
      }
    }),

    // Ticket 9: Error en sistema de facturación
    prisma.ticket.create({
      data: {
        title: 'Sistema de facturación no genera facturas correctamente',
        description: 'El sistema de facturación no está generando las facturas con el formato correcto. Los números de factura están duplicados.',
        priority: TicketPriority.URGENT,
        status: TicketStatus.OPEN,
        requesterId: user3.id
      }
    }),

    // Ticket 10: Escáner no funciona
    prisma.ticket.create({
      data: {
        title: 'Escáner del departamento de recursos humanos no funciona',
        description: 'El escáner del departamento de RRHH no está funcionando correctamente. Muestra un error de "Hardware not found".',
        priority: TicketPriority.MEDIUM,
        status: TicketStatus.IN_PROGRESS,
        requesterId: user1.id,
        assigneeId: agent2.id
      }
    })
  ]);

  console.log('✅ Tickets creados');

  // Crear comentarios
  console.log('💬 Creando comentarios...');

  const comments = await Promise.all([
    // Comentarios para Ticket 2 (Impresora)
    prisma.comment.create({
      data: {
        ticketId: tickets[1].id,
        authorId: agent1.id,
        message: 'He revisado el problema. Parece ser un problema de drivers. Voy a actualizarlos y reiniciar la impresora.'
      }
    }),
    prisma.comment.create({
      data: {
        ticketId: tickets[1].id,
        authorId: user2.id,
        message: 'Gracias por la actualización. ¿Cuándo estará listo? Necesito imprimir algunos documentos urgentes.'
      }
    }),
    prisma.comment.create({
      data: {
        ticketId: tickets[1].id,
        authorId: agent1.id,
        message: 'Ya está funcionando. He actualizado los drivers y reiniciado la impresora. Puedes probar ahora.'
      }
    }),

    // Comentarios para Ticket 3 (Adobe Photoshop)
    prisma.comment.create({
      data: {
        ticketId: tickets[2].id,
        authorId: agent2.id,
        message: 'Software instalado correctamente. Por favor, reinicia tu computadora para que los cambios surtan efecto.'
      }
    }),
    prisma.comment.create({
      data: {
        ticketId: tickets[2].id,
        authorId: user3.id,
        message: 'Perfecto, ya funciona. Gracias por la instalación rápida!'
      }
    }),

    // Comentarios para Ticket 5 (Email)
    prisma.comment.create({
      data: {
        ticketId: tickets[4].id,
        authorId: agent1.id,
        message: 'He verificado la configuración SMTP. El problema está en la autenticación. Voy a restablecer tu contraseña de email.'
      }
    }),

    // Comentarios para Ticket 7 (Proyector)
    prisma.comment.create({
      data: {
        ticketId: tickets[6].id,
        authorId: agent1.id,
        message: 'Proyector reparado. El problema era un cable HDMI defectuoso. Ya está funcionando correctamente.'
      }
    }),

    // Comentarios para Ticket 8 (Carpeta compartida)
    prisma.comment.create({
      data: {
        ticketId: tickets[7].id,
        authorId: agent2.id,
        message: 'Acceso otorgado a la carpeta compartida del proyecto X. Deberías poder verla en tu explorador de archivos.'
      }
    })
  ]);

  console.log('✅ Comentarios creados');

  // Crear notificaciones
  console.log('🔔 Creando notificaciones...');

  const notifications = await Promise.all([
    // Notificación para usuario1 sobre ticket asignado
    prisma.notification.create({
      data: {
        userId: user1.id,
        title: 'Ticket actualizado',
        message: 'Tu ticket "Proyector de la sala de conferencias no se conecta" ha sido resuelto.',
        type: 'TICKET_UPDATE',
        read: false
      }
    }),

    // Notificación para agente1 sobre nuevo ticket
    prisma.notification.create({
      data: {
        userId: agent1.id,
        title: 'Nuevo ticket asignado',
        message: 'Se te ha asignado el ticket "Impresora del departamento de contabilidad no funciona".',
        type: 'TICKET_ASSIGNED',
        read: false
      }
    }),

    // Notificación para agente2 sobre ticket resuelto
    prisma.notification.create({
      data: {
        userId: agent2.id,
        title: 'Ticket resuelto',
        message: 'El ticket "Necesito instalar Adobe Photoshop" ha sido marcado como resuelto.',
        type: 'TICKET_RESOLVED',
        read: false
      }
    })
  ]);

  console.log('✅ Notificaciones creadas');

  // Crear preferencias de notificación
  console.log('⚙️ Creando preferencias de notificación...');

  await Promise.all([
    prisma.notificationPreferences.create({
      data: {
        userId: admin.id,
        email: true,
        inApp: true,
        ticketAssigned: true,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    }),
    prisma.notificationPreferences.create({
      data: {
        userId: agent1.id,
        email: true,
        inApp: true,
        ticketAssigned: true,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    }),
    prisma.notificationPreferences.create({
      data: {
        userId: agent2.id,
        email: true,
        inApp: false,
        ticketAssigned: true,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    }),
    prisma.notificationPreferences.create({
      data: {
        userId: user1.id,
        email: false,
        inApp: true,
        ticketAssigned: false,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    }),
    prisma.notificationPreferences.create({
      data: {
        userId: user2.id,
        email: true,
        inApp: true,
        ticketAssigned: false,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    }),
    prisma.notificationPreferences.create({
      data: {
        userId: user3.id,
        email: false,
        inApp: false,
        ticketAssigned: false,
        statusChanged: true,
        commentAdded: true,
        priorityChanged: true
      }
    })
  ]);

  console.log('✅ Preferencias de notificación creadas');

  console.log('🎉 Seed completado exitosamente!');
  console.log('\n📋 Credenciales de acceso:');
  console.log('   👑 Admin: admin@empresa.com / password123');
  console.log('   🛠️  Agente 1: agente1@empresa.com / password123');
  console.log('   🛠️  Agente 2: agente2@empresa.com / password123');
  console.log('   👤 Usuario 1: usuario1@empresa.com / password123');
  console.log('   👤 Usuario 2: usuario2@empresa.com / password123');
  console.log('   👤 Usuario 3: usuario3@empresa.com / password123');
  console.log('\n📊 Estadísticas:');
  console.log(`   🎫 Tickets creados: ${tickets.length}`);
  console.log(`   💬 Comentarios creados: ${comments.length}`);
  console.log(`   🔔 Notificaciones creadas: ${notifications.length}`);
  console.log(`   👥 Usuarios creados: 6`);
}

main()
  .catch((e) => {
    console.error('❌ Error durante el seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
