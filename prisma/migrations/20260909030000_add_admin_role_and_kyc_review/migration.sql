-- SPRINT 5.2 — Back-office RepairDom et vérification KYC manuelle.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
--
-- 1. Ajout du rôle interne ADMIN à l'enum Role existant (CLIENT/TECHNICIAN
--    inchangés). Ajout dans une transaction PostgreSQL 12+ : autorisé tant que
--    la nouvelle valeur n'est pas utilisée dans cette même migration.
-- 2. Ajout du motif de rejet KYC sur TechnicianProfile (nullable).
-- 3. Nouveau modèle KycReview : journal d'audit des décisions admin
--    (quel admin, quel technicien, transition, date, motif).

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'ADMIN';

-- AlterTable
ALTER TABLE "TechnicianProfile" ADD COLUMN "kycRejectionReason" TEXT;

-- CreateTable
CREATE TABLE "KycReview" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "technicianId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "previousStatus" "KycStatus" NOT NULL,
    "newStatus" "KycStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycReview_technicianId_idx" ON "KycReview"("technicianId");
CREATE INDEX "KycReview_reviewerId_idx" ON "KycReview"("reviewerId");

-- AddForeignKey
ALTER TABLE "KycReview" ADD CONSTRAINT "KycReview_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycReview" ADD CONSTRAINT "KycReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;