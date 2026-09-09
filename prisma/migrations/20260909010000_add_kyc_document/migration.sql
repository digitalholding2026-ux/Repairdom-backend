-- SPRINT 5 — Soumission KYC : stockage privé des documents.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
-- Le statut KycStatus existant est conservé ; cette migration n'ajoute qu'un
-- nouveau modèle de métadonnées de documents KYC.

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('IDENTITY', 'PROFESSIONAL');

-- CreateTable
CREATE TABLE "KycDocument" (
    "id" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "type" "KycDocumentType" NOT NULL,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycDocument_technicianId_idx" ON "KycDocument"("technicianId");

-- AddForeignKey
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;