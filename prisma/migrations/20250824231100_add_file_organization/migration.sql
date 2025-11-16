-- CreateTable
CREATE TABLE "file_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#3B82F6',
    "icon" TEXT NOT NULL DEFAULT '📁',
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_organizations" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "categoryId" TEXT,
    "tags" TEXT[],
    "customPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_categories_name_key" ON "file_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "file_tags_name_key" ON "file_tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "file_organizations_attachmentId_key" ON "file_organizations"("attachmentId");

-- AddForeignKey
ALTER TABLE "file_categories" ADD CONSTRAINT "file_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "file_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_organizations" ADD CONSTRAINT "file_organizations_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_organizations" ADD CONSTRAINT "file_organizations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "file_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
