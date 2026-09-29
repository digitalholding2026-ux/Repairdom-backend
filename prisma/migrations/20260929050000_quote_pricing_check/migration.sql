-- IA-6 — surveillance déterministe des tarifs (signal, jamais de blocage).
--
-- NON DESTRUCTIVE : table additive uniquement, aucune colonne modifiée,
-- aucune donnée existante touchée. Chaque devis MANUAL reçoit au plus UNE
-- ligne (UNIQUE quoteId, création unique, jamais réécrite) : le snapshot
-- min/référence/max y est figé au moment du contrôle, donc une modification
-- ultérieure du barème ne change jamais un contrôle historique.
-- Devis et montants intacts ; montants entiers XAF (pas de flottants).

CREATE TABLE "QuotePricingCheck" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "quoteId" TEXT NOT NULL,
  "demandeId" TEXT NOT NULL,
  "diagnosticId" TEXT,
  "catalogDiagnosticId" TEXT,
  "proposedPrice" INTEGER NOT NULL,
  "minAtCheck" INTEGER,
  "referenceAtCheck" INTEGER,
  "maxAtCheck" INTEGER,
  "result" TEXT NOT NULL,
  "pricingIds" TEXT[] NOT NULL DEFAULT '{}',
  "deviationAmount" INTEGER,
  "deviationBps" INTEGER,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QuotePricingCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuotePricingCheck_quoteId_key" ON "QuotePricingCheck"("quoteId");

CREATE INDEX "QuotePricingCheck_demandeId_idx" ON "QuotePricingCheck"("demandeId");

CREATE INDEX "QuotePricingCheck_result_idx" ON "QuotePricingCheck"("result");

ALTER TABLE "QuotePricingCheck"
  ADD CONSTRAINT "QuotePricingCheck_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
