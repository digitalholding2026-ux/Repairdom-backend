-- IA-5 — correspondance IA entre diagnostic libre et catalogue (analytique).
--
-- NON DESTRUCTIVE : table additive uniquement, aucune colonne modifiée,
-- aucune donnée existante touchée. Le diagnostic libre (texte/audio/mode)
-- et les devis restent intacts ; seule une ligne d'analyse par diagnostic
-- peut exister (UNIQUE diagnosticId, rejouée sans doublon).

CREATE TABLE "DiagnosticCatalogMatch" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "diagnosticId" TEXT NOT NULL,
  "catalogDiagnosticId" TEXT,
  "confidence" DOUBLE PRECISION,
  "classification" TEXT NOT NULL,
  "model" TEXT,
  "promptVersion" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiagnosticCatalogMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiagnosticCatalogMatch_diagnosticId_key" ON "DiagnosticCatalogMatch"("diagnosticId");

CREATE INDEX "DiagnosticCatalogMatch_catalogDiagnosticId_idx" ON "DiagnosticCatalogMatch"("catalogDiagnosticId");

ALTER TABLE "DiagnosticCatalogMatch"
  ADD CONSTRAINT "DiagnosticCatalogMatch_diagnosticId_fkey"
  FOREIGN KEY ("diagnosticId") REFERENCES "Diagnostic"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiagnosticCatalogMatch"
  ADD CONSTRAINT "DiagnosticCatalogMatch_catalogDiagnosticId_fkey"
  FOREIGN KEY ("catalogDiagnosticId") REFERENCES "CatalogDiagnostic"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
