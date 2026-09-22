-- SPRINT ADMIN SUPER POWERS — Centre de contrôle back-office.
-- Migration strictement ADDITIVE et NON DESTRUCTIVE :
--
-- 1. User.isActive (BOOLEAN, défaut true) : désactivation logique des comptes
--    CLIENT/TECHNICIAN quand l'historique métier ou financier interdit une
--    suppression physique. Aucune ligne existante n'est modifiée au-delà du
--    défaut (tous les comptes restent actifs).
-- 2. NotificationType += ADMIN_MESSAGE (message direct admin → technicien,
--    sans mission liée).
-- 3. FinancialTransactionType += RELIO_WITHDRAWAL (écriture ledger immuable
--    adossée à chaque retrait de fonds Relio).
-- 4. RelioWithdrawal : traçabilité des retraits admin (référence UNIQUE
--    RELIO-WD-… = clé d'idempotence). requestedById en RESTRICT : un admin
--    ayant effectué un retrait ne peut pas être supprimé physiquement.
-- Aucune table/colonne existante modifiée, aucune donnée réécrite.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_MESSAGE';

-- AlterEnum
ALTER TYPE "FinancialTransactionType" ADD VALUE 'RELIO_WITHDRAWAL';

-- AlterTable User : ajout de la désactivation logique (défaut : actif).
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable RelioWithdrawal
CREATE TABLE "RelioWithdrawal" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "mode" "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status" "FinancialTransactionStatus" NOT NULL DEFAULT 'VALIDATED',
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelioWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RelioWithdrawal_reference_key" ON "RelioWithdrawal"("reference");
CREATE INDEX "RelioWithdrawal_mode_createdAt_idx" ON "RelioWithdrawal"("mode", "createdAt");

-- AddForeignKey
ALTER TABLE "RelioWithdrawal" ADD CONSTRAINT "RelioWithdrawal_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
