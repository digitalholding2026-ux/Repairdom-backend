-- IA-7 — système d'avertissements tarifaires (surveillance progressive).
--
-- NON DESTRUCTIVE : table additive + 1 valeur d'enum, aucune colonne
-- modifiée, aucune donnée existante touchée. L'expiration est DÉRIVÉE
-- (PENDING + dueAt dépassé), jamais réécrite par timer : aucun cron requis.
-- Historique immuable (justification et revue s'ajoutent, rien n'est
-- écrasé ni supprimé). Aucune sanction automatique possible par schéma.

CREATE TYPE "AiWarningType" AS ENUM ('PRICE_ABOVE_MAX');

CREATE TYPE "AiWarningStatus" AS ENUM ('PENDING', 'JUSTIFIED', 'REVIEWED');

CREATE TABLE "AiWarning" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "technicianId" TEXT NOT NULL,
  "demandeId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "diagnosticId" TEXT,
  "pricingCheckId" TEXT NOT NULL,
  "warningType" "AiWarningType" NOT NULL DEFAULT 'PRICE_ABOVE_MAX',
  "status" "AiWarningStatus" NOT NULL DEFAULT 'PENDING',
  "dueAt" TIMESTAMP(3) NOT NULL,
  "justification" TEXT,
  "justifiedAt" TIMESTAMP(3),
  "isLateJustification" BOOLEAN NOT NULL DEFAULT false,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiWarning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiWarning_pricingCheckId_key" ON "AiWarning"("pricingCheckId");

CREATE INDEX "AiWarning_technicianId_status_idx" ON "AiWarning"("technicianId", "status");

CREATE INDEX "AiWarning_demandeId_idx" ON "AiWarning"("demandeId");

CREATE INDEX "AiWarning_status_dueAt_idx" ON "AiWarning"("status", "dueAt");

ALTER TABLE "AiWarning"
  ADD CONSTRAINT "AiWarning_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiWarning"
  ADD CONSTRAINT "AiWarning_demandeId_fkey"
  FOREIGN KEY ("demandeId") REFERENCES "Demande"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiWarning"
  ADD CONSTRAINT "AiWarning_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiWarning"
  ADD CONSTRAINT "AiWarning_pricingCheckId_fkey"
  FOREIGN KEY ("pricingCheckId") REFERENCES "QuotePricingCheck"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiWarning"
  ADD CONSTRAINT "AiWarning_reviewedBy_fkey"
  FOREIGN KEY ("reviewedBy") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Notification technicien (infra existante réutilisée ; précédent ALTER TYPE
-- établi et déployé : DemandeStatus, Role).
ALTER TYPE "NotificationType" ADD VALUE 'PRICING_WARNING';
