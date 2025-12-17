import { prisma } from "../lib/database";

async function main() {
    console.log("🔍 Checking for attachments without FileOrganization records...");

    // Find attachments that have NO FileOrganization records
    const attachmentsWithoutOrg = await prisma.attachment.findMany({
        where: {
            organizations: {
                none: {}
            }
        }
    });

    console.log(`Found ${attachmentsWithoutOrg.length} attachments needing migration.`);

    if (attachmentsWithoutOrg.length === 0) {
        console.log("✅ All systems go. No action needed.");
        return;
    }

    console.log("🚀 Starting migration...");
    let count = 0;

    for (const att of attachmentsWithoutOrg) {
        await prisma.fileOrganization.create({
            data: {
                attachmentId: att.id,
                tags: [],
                categoryId: null,
            }
        });
        count++;
        process.stdout.write(`\rProcessed: ${count}/${attachmentsWithoutOrg.length}`);
    }

    console.log("\n✅ Migration complete!");
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
