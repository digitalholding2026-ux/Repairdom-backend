-- M1-HISTORIQUE — Table des retraits de fonds Relio, extraite de
-- 20260922010000_admin_super_powers.
--
-- Le sprint « admin super powers » déclarait ici la valeur `RELIO_WITHDRAWAL`
-- et la table `RelioWithdrawal`, mais ces deux objets dépendent des types
-- `FinancialTransactionType`, `FinancialTransactionMode` et
-- `FinancialTransactionStatus`, créés seulement par la migration précédente
-- (20260927010000_add_financial_ledger). Appliquée dans l'ordre sur une base
-- vide, l'ancienne version levait « 42704 — type "FinancialTransactionType"
-- does not exist » : `prisma migrate deploy` s'arrêtait là et le conteneur
-- redémarrait en boucle.
--
-- Placement : après le moteur financier (les types existent), avant
-- 20261001010000_saspay_foundations, qui ajoute des colonnes à cette table.
--
-- NON DESTRUCTIF et rejouable : garde pg_enum sur la valeur d'énumération,
-- IF NOT EXISTS sur la table et les index, exception duplicate_object sur la
-- contrainte de clé étrangère.

-- AlterEnum FinancialTransactionType : écriture ledger du retrait Relio.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'FinancialTransactionType' AND e.enumlabel = 'RELIO_WITHDRAWAL') THEN
        ALTER TYPE "FinancialTransactionType" ADD VALUE 'RELIO_WITHDRAWAL';
    END IF;
END $$;

-- CreateTable RelioWithdrawal : traçabilité des retraits de l'opérateur.
-- `reference` UNIQUE (RELIO-WD-…) sert de clé d'idempotence.
CREATE TABLE IF NOT EXISTS "RelioWithdrawal" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "RelioWithdrawal_reference_key" ON "RelioWithdrawal"("reference");
CREATE INDEX IF NOT EXISTS "RelioWithdrawal_mode_createdAt_idx" ON "RelioWithdrawal"("mode", "createdAt");

-- AddForeignKey : requestedById en RESTRICT — un opérateur ayant effectué un
-- retrait ne peut pas être supprimé physiquement.
DO $$ BEGIN
    ALTER TABLE "RelioWithdrawal" ADD CONSTRAINT "RelioWithdrawal_requestedById_fkey"
        FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
