import { prisma } from "../lib/database";

async function main() {
    const ticketNumber = 11; // User said 00011

    console.log(`Searching for ticket number: ${ticketNumber}`);

    const ticket = await prisma.ticket.findUnique({
        where: { ticketNumber },
        include: {
            attachments: {
                include: {
                    organizations: true
                }
            }
        }
    });

    if (!ticket) {
        console.log("Ticket not found!");
        return;
    }

    console.log(`Ticket ID: ${ticket.id}`);
    console.log(`Total attachments: ${ticket.attachments.length}`);

    ticket.attachments.forEach(att => {
        console.log(`\nAttachment: ${att.fileName} (ID: ${att.id})`);
        console.log(`Organization records: ${att.organizations.length}`);
        if (att.organizations.length === 0) {
            console.log("⚠️  MISSING FILE ORGANIZATION RECORD");
        } else {
            console.log("✅ Organization record present");
        }
    });
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
