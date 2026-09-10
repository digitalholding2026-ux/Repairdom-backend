-- SPRINT 8.1 — Connexion catalogue → mission.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive : toutes les
-- colonnes ajoutées sont nullable ou à défaut, afin de préserver les
-- demandes/missions existantes (Test K).
--
-- 1. DeviceBrand / DeviceModel : marques et modèles d'appareils, génériques
--    (Smartphone → Tecno → Spark 10, Ordinateur → HP → …, etc.).
-- 2. ServiceDomain.category : catégorie métier « historique » pour dériver la
--    catégorie de matching d'une demande issue du catalogue (Sprint 8.1).
-- 3. Problem.brandId / modelId : ancrage optionnel d'un problème sur une
--    marque et/ou un modèle (spécifique si présent, générique sinon).
-- 4. Demande : domaine/marque/modèle/problème du contexte matériel client,
--    + negotiationRequestedAt (ouverture du chat de négociation) + finalAmount
--    (traçabilité du prix final accepté).
-- 5. Diagnostic : lien optionnel vers le diagnostic + l'intervention du
--    catalogue (NULL = anomalie libre, fallback contrôlé).
-- 6. Quote : source (CATALOG/MANUAL) + snapshot du prix catalogue au moment de
--    la proposition (initialReferencePrice / initialTravelFee / initialServiceFee).

-- CreateTable DeviceBrand
CREATE TABLE "DeviceBrand" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "domainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceBrand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceBrand_domainId_slug_key" ON "DeviceBrand"("domainId", "slug");
CREATE INDEX "DeviceBrand_domainId_idx" ON "DeviceBrand"("domainId");
CREATE INDEX "DeviceBrand_isActive_idx" ON "DeviceBrand"("isActive");

-- CreateTable DeviceModel
CREATE TABLE "DeviceModel" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_brandId_slug_key" ON "DeviceModel"("brandId", "slug");
CREATE INDEX "DeviceModel_brandId_idx" ON "DeviceModel"("brandId");
CREATE INDEX "DeviceModel_isActive_idx" ON "DeviceModel"("isActive");

-- AlterTable ServiceDomain
ALTER TABLE "ServiceDomain" ADD COLUMN "category" TEXT;

-- AlterTable Problem
ALTER TABLE "Problem" ADD COLUMN "brandId" TEXT;
ALTER TABLE "Problem" ADD COLUMN "modelId" TEXT;

-- AlterTable Demande
ALTER TABLE "Demande" ADD COLUMN "domainId" TEXT;
ALTER TABLE "Demande" ADD COLUMN "brandId" TEXT;
ALTER TABLE "Demande" ADD COLUMN "modelId" TEXT;
ALTER TABLE "Demande" ADD COLUMN "problemId" TEXT;
ALTER TABLE "Demande" ADD COLUMN "negotiationRequestedAt" TIMESTAMP(3);
ALTER TABLE "Demande" ADD COLUMN "finalAmount" INTEGER;

-- AlterTable Diagnostic
ALTER TABLE "Diagnostic" ADD COLUMN "catalogDiagnosticId" TEXT;
ALTER TABLE "Diagnostic" ADD COLUMN "catalogInterventionId" TEXT;

-- AlterTable Quote
ALTER TABLE "Quote" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Quote" ADD COLUMN "catalogDiagnosticId" TEXT;
ALTER TABLE "Quote" ADD COLUMN "catalogInterventionId" TEXT;
ALTER TABLE "Quote" ADD COLUMN "initialReferencePrice" INTEGER;
ALTER TABLE "Quote" ADD COLUMN "initialTravelFee" INTEGER;
ALTER TABLE "Quote" ADD COLUMN "initialServiceFee" INTEGER;

-- CreateIndex
CREATE INDEX "Problem_brandId_idx" ON "Problem"("brandId");
CREATE INDEX "Problem_modelId_idx" ON "Problem"("modelId");
CREATE INDEX "Demande_domainId_idx" ON "Demande"("domainId");
CREATE INDEX "Demande_brandId_idx" ON "Demande"("brandId");
CREATE INDEX "Demande_modelId_idx" ON "Demande"("modelId");
CREATE INDEX "Demande_problemId_idx" ON "Demande"("problemId");
CREATE INDEX "Diagnostic_catalogDiagnosticId_idx" ON "Diagnostic"("catalogDiagnosticId");
CREATE INDEX "Diagnostic_catalogInterventionId_idx" ON "Diagnostic"("catalogInterventionId");
CREATE INDEX "Quote_catalogDiagnosticId_idx" ON "Quote"("catalogDiagnosticId");
CREATE INDEX "Quote_catalogInterventionId_idx" ON "Quote"("catalogInterventionId");

-- AddForeignKey
ALTER TABLE "DeviceBrand" ADD CONSTRAINT "DeviceBrand_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "ServiceDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceModel" ADD CONSTRAINT "DeviceModel_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "DeviceBrand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "DeviceBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "DeviceModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "ServiceDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "DeviceBrand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "DeviceModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnostic" ADD CONSTRAINT "Diagnostic_catalogDiagnosticId_fkey" FOREIGN KEY ("catalogDiagnosticId") REFERENCES "CatalogDiagnostic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnostic" ADD CONSTRAINT "Diagnostic_catalogInterventionId_fkey" FOREIGN KEY ("catalogInterventionId") REFERENCES "CatalogIntervention"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_catalogDiagnosticId_fkey" FOREIGN KEY ("catalogDiagnosticId") REFERENCES "CatalogDiagnostic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_catalogInterventionId_fkey" FOREIGN KEY ("catalogInterventionId") REFERENCES "CatalogIntervention"("id") ON DELETE SET NULL ON UPDATE CASCADE;