-- SPRINT SASPAY-01 — Fondations financières SasPay (sans appels API réels).
-- Migration strictement ADDITIVE et NON DESTRUCTIVE :
--
-- 1. FinancialTransactionType += CLIENT_TOPUP (recharge réelle confirmée
--    serveur), CLIENT_WITHDRAWAL, TECHNICIAN_WITHDRAWAL (débits définitifs
--    créés uniquement au SUCCESS d'un payout). Aucune écriture historique
--    n'est modifiée ; les types legacy restent intacts.
-- 2. Nouveaux enums : SasPayOperationStatus (PENDING/SUCCESS/FAILED/
--    CANCELLED) et FundsHoldStatus (ACTIVE/RELEASED/CONSUMED).
-- 3. Nouvelles tables TopupIntent, WithdrawalRequest, FundsHold : suivi des
--    intentions/requêtes/verrous logiques. AUCUNE ne porte un solde et
--    aucune ne remplace le ledger FinancialTransaction (source de vérité).
-- 4. RelioWithdrawal += payoutStatus (défaut SUCCESS = comportement
--    historique synchrone préservé) + références SasPay + idempotencyKey
--    UNIQUE (NULL pour l'historique) + errorMessage + updatedAt.
--    Seuls les retraits payoutStatus = SUCCESS réduisent le disponible.
-- Aucune table/colonne existante modifiée en dehors de ces ajouts, aucune
-- donnée réécrite, aucun endpoint cassé.

-- AlterEnum FinancialTransactionType : nouveaux types (idempotents si relancés
-- partiellement — DO blocks avec garde sur pg_enum).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FinancialTransactionType' AND e.enumlabel = 'CLIENT_TOPUP') THEN
    ALTER TYPE "FinancialTransactionType" ADD VALUE 'CLIENT_TOPUP';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FinancialTransactionType' AND e.enumlabel = 'CLIENT_WITHDRAWAL') THEN
    ALTER TYPE "FinancialTransactionType" ADD VALUE 'CLIENT_WITHDRAWAL';
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FinancialTransactionType' AND e.enumlabel = 'TECHNICIAN_WITHDRAWAL') THEN
    ALTER TYPE "FinancialTransactionType" ADD VALUE 'TECHNICIAN_WITHDRAWAL';
  END IF;
END $$;

-- CreateEnum SasPayOperationStatus
DO $$ BEGIN
  CREATE TYPE "SasPayOperationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum FundsHoldStatus
DO $$ BEGIN
  CREATE TYPE "FundsHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable RelioWithdrawal : payout async + réconciliation SasPay.
ALTER TABLE "RelioWithdrawal"
  ADD COLUMN IF NOT EXISTS "payoutStatus" "SasPayOperationStatus" NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN IF NOT EXISTS "saspayTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "saspayReference" TEXT,
  ADD COLUMN IF NOT EXISTS "externalReference" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Les lignes historiques (retraits synchrones) restent SUCCESS : le défaut
-- ci-dessus s'applique déjà ; garde explicite par sécurité.
UPDATE "RelioWithdrawal" SET "payoutStatus" = 'SUCCESS' WHERE "payoutStatus" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "RelioWithdrawal_idempotencyKey_key" ON "RelioWithdrawal"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_payoutStatus_idx" ON "RelioWithdrawal"("payoutStatus");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_saspayTransactionId_idx" ON "RelioWithdrawal"("saspayTransactionId");

-- CreateTable TopupIntent
CREATE TABLE IF NOT EXISTS "TopupIntent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "mode" "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status" "SasPayOperationStatus" NOT NULL DEFAULT 'PENDING',
    "saspayTransactionId" TEXT,
    "saspayReference" TEXT,
    "externalReference" TEXT,
    "network" TEXT,
    "country" TEXT,
    "requestedAmount" INTEGER,
    "fee" INTEGER,
    "chargedAmount" INTEGER,
    "netAmount" INTEGER,
    "creditedTransactionId" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopupIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TopupIntent_reference_key" ON "TopupIntent"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "TopupIntent_idempotencyKey_key" ON "TopupIntent"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "TopupIntent_userId_createdAt_idx" ON "TopupIntent"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "TopupIntent_status_idx" ON "TopupIntent"("status");
CREATE INDEX IF NOT EXISTS "TopupIntent_saspayTransactionId_idx" ON "TopupIntent"("saspayTransactionId");

-- CreateTable WithdrawalRequest
CREATE TABLE IF NOT EXISTS "WithdrawalRequest" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "mode" "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status" "SasPayOperationStatus" NOT NULL DEFAULT 'PENDING',
    "holdId" TEXT,
    "ledgerReference" TEXT,
    "saspayTransactionId" TEXT,
    "saspayReference" TEXT,
    "externalReference" TEXT,
    "network" TEXT,
    "country" TEXT,
    "requestedAmount" INTEGER,
    "fee" INTEGER,
    "chargedAmount" INTEGER,
    "netAmount" INTEGER,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_reference_key" ON "WithdrawalRequest"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_userId_createdAt_idx" ON "WithdrawalRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_idx" ON "WithdrawalRequest"("status");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_saspayTransactionId_idx" ON "WithdrawalRequest"("saspayTransactionId");

-- CreateTable FundsHold
CREATE TABLE IF NOT EXISTS "FundsHold" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "demandeId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "mode" "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status" "FundsHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "FundsHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FundsHold_reference_key" ON "FundsHold"("reference");
CREATE INDEX IF NOT EXISTS "FundsHold_userId_status_idx" ON "FundsHold"("userId", "status");
CREATE INDEX IF NOT EXISTS "FundsHold_demandeId_idx" ON "FundsHold"("demandeId");
CREATE INDEX IF NOT EXISTS "FundsHold_mode_status_idx" ON "FundsHold"("mode", "status");

-- AddForeignKey (ordre : FundsHold d'abord, WithdrawalRequest.holdId ensuite).
DO $$ BEGIN
  ALTER TABLE "TopupIntent" ADD CONSTRAINT "TopupIntent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "TopupIntent" ADD CONSTRAINT "TopupIntent_creditedTransactionId_fkey"
    FOREIGN KEY ("creditedTransactionId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "TopupIntent" ADD CONSTRAINT "TopupIntent_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FundsHold" ADD CONSTRAINT "FundsHold_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FundsHold" ADD CONSTRAINT "FundsHold_demandeId_fkey"
    FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FundsHold" ADD CONSTRAINT "FundsHold_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_holdId_fkey"
    FOREIGN KEY ("holdId") REFERENCES "FundsHold"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
