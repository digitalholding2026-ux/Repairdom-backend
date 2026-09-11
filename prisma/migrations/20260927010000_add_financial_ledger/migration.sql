-- SPRINT 8.7-FIN — Moteur financier de simulation RepairDom.
-- Ledger financier immuable (FinancialTransaction) + composante transport
-- des tarifs (Quote.travelAmount) + contrainte d'unicité « un seul tarif
-- ACCEPTED par mission ».
--
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (prisma migrate deploy sur PostgreSQL Railway).
-- NON DESTRUCTIVE :
--   - Quote.travelAmount est nullable : aucune valeur existante n'est altérée ;
--   - les éventuelles doubles acceptations préexistantes sont normalisées
--     (une seule ACCEPTED conservée par mission, les autres rejetées) avant la
--     création de l'index partiel — sans aucune écriture financière (le ledger
--     n'existait pas avant cette migration, aucun backfill rétroactif) ;
--   - aucune transaction rétroactive n'est créée pour les anciennes missions.

-- CreateEnum FinancialTransactionType
CREATE TYPE "FinancialTransactionType" AS ENUM (
    'INITIAL_TEST_CREDIT',
    'CLIENT_MISSION_DEBIT',
    'CLIENT_FEE',
    'TECHNICIAN_REPAIR_REVENUE',
    'TECHNICIAN_TRAVEL_REVENUE',
    'TECHNICIAN_FEE',
    'REVERSAL'
);

-- CreateEnum FinancialTransactionDirection
CREATE TYPE "FinancialTransactionDirection" AS ENUM (
    'CREDIT',
    'DEBIT'
);

-- CreateEnum FinancialTransactionStatus
CREATE TYPE "FinancialTransactionStatus" AS ENUM (
    'VALIDATED',
    'REVERSED'
);

-- CreateEnum FinancialTransactionMode
CREATE TYPE "FinancialTransactionMode" AS ENUM (
    'SIMULATION',
    'REAL'
);

-- AlterTable Quote : ajout de la composante transport (nullable).
ALTER TABLE "Quote" ADD COLUMN "travelAmount" INTEGER;

-- Normalisation préventive des doubles acceptations (cas pathologique d'une
-- course concurrente avant l'introduction de la contrainte) : on conserve la
-- PREMIÈRE acceptation par mission, les autres passent à REJECTED.
-- Aucune donnée financière n'est touchée (le ledger n'existe pas encore).
UPDATE "Quote" q SET "status" = 'REJECTED'
FROM (
  SELECT "demandeId", id,
         row_number() OVER (PARTITION BY "demandeId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Quote"
  WHERE "status" = 'ACCEPTED'
) dups
WHERE q.id = dups.id AND dups.rn > 1;

-- Cohérence : si des doublons existaient, le finalAmount suit la première
-- acceptation conservée (sinon sans effet).
UPDATE "Demande" d SET "finalAmount" = kept.amount
FROM (
  SELECT DISTINCT ON ("demandeId") "demandeId", "amount"
  FROM "Quote"
  WHERE "status" = 'ACCEPTED'
  ORDER BY "demandeId", "createdAt" ASC, "id" ASC
) kept
WHERE d.id = kept."demandeId"
  AND d."finalAmount" IS NOT NULL
  AND d."finalAmount" <> kept.amount;

-- CreateIndex (partiel) : un seul tarif ACCEPTED par mission.
CREATE UNIQUE INDEX "Quote_one_accepted_per_demande" ON "Quote"("demandeId") WHERE "status" = 'ACCEPTED';

-- CreateTable FinancialTransaction
CREATE TABLE "FinancialTransaction" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "demandeId" TEXT,
    "type" "FinancialTransactionType" NOT NULL,
    "direction" "FinancialTransactionDirection" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "FinancialTransactionStatus" NOT NULL DEFAULT 'VALIDATED',
    "mode" "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "reference" TEXT NOT NULL,
    "reversalOfId" TEXT,
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialTransaction_reference_key" ON "FinancialTransaction"("reference");
CREATE INDEX "FinancialTransaction_userId_createdAt_idx" ON "FinancialTransaction"("userId", "createdAt");
CREATE INDEX "FinancialTransaction_demandeId_createdAt_idx" ON "FinancialTransaction"("demandeId", "createdAt");
CREATE INDEX "FinancialTransaction_mode_userId_idx" ON "FinancialTransaction"("mode", "userId");

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_demandeId_fkey"
    FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (auto-référence de contrepassation : reversalOfId → id)
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_reversalOfId_fkey"
    FOREIGN KEY ("reversalOfId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (auteur serveur de l'écriture : ADMIN / acteur de la transition)
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;