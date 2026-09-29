-- IA-4 — classification des demandes « Autre » (aide au dispatch).
--
-- NON DESTRUCTIVE : table additive uniquement, aucune colonne modifiée,
-- aucune donnée existante touchée. La donnée client (Demande.category)
-- n'est jamais écrasée : la proposition IA vit dans cette table auditable
-- (une ligne par demande, fallback tracé avec motif).
-- Le dispatch la lit comme signal d'enrichissement, jamais comme décision.

CREATE TABLE "DemandeClassification" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "demandeId" TEXT NOT NULL,
  "domainId" TEXT,
  "categories" TEXT[] NOT NULL DEFAULT '{}',
  "confidence" DOUBLE PRECISION,
  "classification" TEXT NOT NULL,
  "model" TEXT,
  "promptVersion" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DemandeClassification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DemandeClassification_demandeId_key" ON "DemandeClassification"("demandeId");

CREATE INDEX "DemandeClassification_domainId_idx" ON "DemandeClassification"("domainId");

ALTER TABLE "DemandeClassification"
  ADD CONSTRAINT "DemandeClassification_demandeId_fkey"
  FOREIGN KEY ("demandeId") REFERENCES "Demande"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
