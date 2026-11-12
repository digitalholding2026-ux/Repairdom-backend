-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "catalogItemId" TEXT;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "CatalogItem"("id") ON DELETE SET NULL;
