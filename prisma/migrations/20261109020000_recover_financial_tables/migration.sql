-- RÉCUPÉRATION — tables et énumérations financières manquantes en production.
--
-- Contexte : la base de production est en drift. Plusieurs migrations
-- financières (20260927010000_add_financial_ledger et
-- 20261001010000_saspay_foundations) sont enregistrées comme appliquées
-- dans _prisma_migrations, mais leurs tables (FinancialTransaction,
-- FundsHold, TopupIntent, WithdrawalRequest) n'existent pas réellement.
-- prisma migrate deploy les saute donc, et EscrowCronService crash sur
-- P2021 (table FundsHold introuvable).
--
-- Cette migration recrée tous les objets financiers avec des gardes
-- d'idempotence (IF NOT EXISTS / EXCEPTION WHEN duplicate_object /
-- undefined_table), de sorte qu'elle peut être relancée sans risque même
-- si certains objets existent déjà.

-- --- Énumérations (idempotentes) -------------------------------------------

DO $$ BEGIN
  CREATE TYPE "FinancialTransactionType" AS ENUM (
    'INITIAL_TEST_CREDIT', 'CLIENT_MISSION_DEBIT', 'CLIENT_FEE',
    'TECHNICIAN_REPAIR_REVENUE', 'TECHNICIAN_TRAVEL_REVENUE',
    'TECHNICIAN_FEE', 'REVERSAL'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "FinancialTransactionDirection" AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "FinancialTransactionStatus" AS ENUM ('VALIDATED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "FinancialTransactionMode" AS ENUM ('SIMULATION', 'REAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SasPayOperationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "FundsHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --- Table FinancialTransaction --------------------------------------------

CREATE TABLE IF NOT EXISTS "FinancialTransaction" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "userId"          TEXT         NOT NULL,
    "demandeId"       TEXT,
    "type"            "FinancialTransactionType" NOT NULL,
    "direction"       "FinancialTransactionDirection" NOT NULL,
    "amount"          INTEGER      NOT NULL,
    "status"          "FinancialTransactionStatus" NOT NULL DEFAULT 'VALIDATED',
    "mode"            "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "reference"       TEXT         NOT NULL,
    "reversalOfId"    TEXT,
    "metadata"        JSONB,
    "createdById"     TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FinancialTransaction_reference_key"
    ON "FinancialTransaction"("reference");
CREATE INDEX IF NOT EXISTS "FinancialTransaction_userId_createdAt_idx"
    ON "FinancialTransaction"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "FinancialTransaction_demandeId_createdAt_idx"
    ON "FinancialTransaction"("demandeId", "createdAt");
CREATE INDEX IF NOT EXISTS "FinancialTransaction_mode_userId_idx"
    ON "FinancialTransaction"("mode", "userId");

-- --- Table FundsHold ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS "FundsHold" (
    "id"          TEXT           NOT NULL DEFAULT gen_random_uuid(),
    "reference"   TEXT           NOT NULL,
    "userId"      TEXT           NOT NULL,
    "demandeId"   TEXT,
    "amount"      INTEGER        NOT NULL,
    "currency"    TEXT           NOT NULL DEFAULT 'XAF',
    "mode"        "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status"      "FundsHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata"    JSONB,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt"  TIMESTAMP(3),

    CONSTRAINT "FundsHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FundsHold_reference_key"
    ON "FundsHold"("reference");
CREATE INDEX IF NOT EXISTS "FundsHold_userId_status_idx"
    ON "FundsHold"("userId", "status");
CREATE INDEX IF NOT EXISTS "FundsHold_demandeId_idx"
    ON "FundsHold"("demandeId");
CREATE INDEX IF NOT EXISTS "FundsHold_mode_status_idx"
    ON "FundsHold"("mode", "status");

-- --- Table TopupIntent -------------------------------------------------------

CREATE TABLE IF NOT EXISTS "TopupIntent" (
    "id"                   TEXT           NOT NULL DEFAULT gen_random_uuid(),
    "reference"            TEXT           NOT NULL,
    "idempotencyKey"       TEXT           NOT NULL,
    "userId"               TEXT           NOT NULL,
    "amount"               INTEGER        NOT NULL,
    "currency"             TEXT           NOT NULL DEFAULT 'XAF',
    "mode"                 "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status"               "SasPayOperationStatus" NOT NULL DEFAULT 'PENDING',
    "saspayTransactionId"  TEXT,
    "saspayReference"      TEXT,
    "externalReference"    TEXT,
    "network"              TEXT,
    "country"              TEXT,
    "requestedAmount"      INTEGER,
    "fee"                  INTEGER,
    "chargedAmount"        INTEGER,
    "netAmount"            INTEGER,
    "creditedTransactionId" TEXT,
    "errorMessage"         TEXT,
    "metadata"             JSONB,
    "createdById"          TEXT,
    "createdAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TopupIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TopupIntent_reference_key"
    ON "TopupIntent"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "TopupIntent_idempotencyKey_key"
    ON "TopupIntent"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "TopupIntent_userId_createdAt_idx"
    ON "TopupIntent"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "TopupIntent_status_idx"
    ON "TopupIntent"("status");
CREATE INDEX IF NOT EXISTS "TopupIntent_saspayTransactionId_idx"
    ON "TopupIntent"("saspayTransactionId");

-- --- Table WithdrawalRequest -------------------------------------------------

CREATE TABLE IF NOT EXISTS "WithdrawalRequest" (
    "id"                   TEXT           NOT NULL DEFAULT gen_random_uuid(),
    "reference"            TEXT           NOT NULL,
    "idempotencyKey"       TEXT           NOT NULL,
    "userId"               TEXT           NOT NULL,
    "amount"               INTEGER        NOT NULL,
    "currency"             TEXT           NOT NULL DEFAULT 'XAF',
    "mode"                 "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status"               "SasPayOperationStatus" NOT NULL DEFAULT 'PENDING',
    "holdId"               TEXT,
    "ledgerReference"      TEXT,
    "saspayTransactionId"  TEXT,
    "saspayReference"      TEXT,
    "externalReference"    TEXT,
    "network"              TEXT,
    "country"              TEXT,
    "requestedAmount"      INTEGER,
    "fee"                  INTEGER,
    "chargedAmount"        INTEGER,
    "netAmount"            INTEGER,
    "errorMessage"         TEXT,
    "metadata"             JSONB,
    "createdById"          TEXT,
    "createdAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_reference_key"
    ON "WithdrawalRequest"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalRequest_idempotencyKey_key"
    ON "WithdrawalRequest"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_userId_createdAt_idx"
    ON "WithdrawalRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_status_idx"
    ON "WithdrawalRequest"("status");
CREATE INDEX IF NOT EXISTS "WithdrawalRequest_saspayTransactionId_idx"
    ON "WithdrawalRequest"("saspayTransactionId");

-- --- Table RelioWithdrawal (création si absente, puis colonnes SasPay) -----

CREATE TABLE IF NOT EXISTS "RelioWithdrawal" (
    "id"                  TEXT           NOT NULL DEFAULT gen_random_uuid(),
    "reference"           TEXT           NOT NULL,
    "amount"              INTEGER,
    "note"                TEXT,
    "mode"                "FinancialTransactionMode" NOT NULL DEFAULT 'SIMULATION',
    "status"              "FinancialTransactionStatus" NOT NULL DEFAULT 'VALIDATED',
    "payoutStatus"        "SasPayOperationStatus" NOT NULL DEFAULT 'SUCCESS',
    "saspayTransactionId" TEXT,
    "saspayReference"     TEXT,
    "externalReference"   TEXT,
    "idempotencyKey"      TEXT,
    "errorMessage"        TEXT,
    "requestedById"       TEXT           NOT NULL,
    "createdAt"           TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelioWithdrawal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RelioWithdrawal_reference_key"
    ON "RelioWithdrawal"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "RelioWithdrawal_idempotencyKey_key"
    ON "RelioWithdrawal"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_mode_createdAt_idx"
    ON "RelioWithdrawal"("mode", "createdAt");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_payoutStatus_idx"
    ON "RelioWithdrawal"("payoutStatus");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_saspayTransactionId_idx"
    ON "RelioWithdrawal"("saspayTransactionId");

-- Colonnes SasPay (si la table existait déjà sans elles) :
DO $$ BEGIN
  ALTER TABLE "RelioWithdrawal"
    ADD COLUMN IF NOT EXISTS "payoutStatus" "SasPayOperationStatus" NOT NULL DEFAULT 'SUCCESS',
    ADD COLUMN IF NOT EXISTS "saspayTransactionId" TEXT,
    ADD COLUMN IF NOT EXISTS "saspayReference" TEXT,
    ADD COLUMN IF NOT EXISTS "externalReference" TEXT,
    ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
    ADD COLUMN IF NOT EXISTS "errorMessage" TEXT,
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

UPDATE "RelioWithdrawal" SET "payoutStatus" = 'SUCCESS' WHERE "payoutStatus" IS NULL;

-- --- Clés étrangères (idempotentes) ----------------------------------------

DO $$ BEGIN
  ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_demandeId_fkey"
    FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_reversalOfId_fkey"
    FOREIGN KEY ("reversalOfId") REFERENCES "FinancialTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_createdById_fkey"
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

DO $$ BEGIN
  ALTER TABLE "RelioWithdrawal" ADD CONSTRAINT "RelioWithdrawal_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
