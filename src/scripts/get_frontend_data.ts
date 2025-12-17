import { FileOrganizationService } from "../services/fileOrganization.service";
import { prisma } from "../lib/database";

async function main() {
    const ticket = await prisma.ticket.findUnique({
        where: { ticketNumber: 11 }
    });

    if (!ticket) {
        console.log("Ticket 11 not found");
        return;
    }

    const files = await FileOrganizationService.getTicketFiles(ticket.id);
    console.log(JSON.stringify(files, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
