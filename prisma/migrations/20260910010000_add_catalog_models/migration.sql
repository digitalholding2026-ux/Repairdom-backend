-- SPRINT 8 — Catalogue de services générique RepairDom.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
--
-- 1. ServiceDomain   : domaines (smartphone, ordinateur, console…).
-- 2. Problem         : problèmes propres à un domaine (slug unique par domaine).
-- 3. CatalogDiagnostic : diagnostics propres à un problème (slug unique par problème).
-- 4. CatalogIntervention : interventions liées à un diagnostic (slug unique par diagnostic).
-- 5. Pricing         : tarification (1-1 avec une intervention), valeurs en entiers XAF.
-- 6. PricingHistory  : journal d'audit immuable des modifications de tarif
--                      (quel admin, valeurs précédentes/nouvelles, motif, date).

-- CreateTable ServiceDomain
CREATE TABLE "ServiceDomain" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceDomain_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceDomain_slug_key" ON "ServiceDomain"("slug");
CREATE INDEX "ServiceDomain_isActive_idx" ON "ServiceDomain"("isActive");

-- CreateTable Problem
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "domainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Problem_domainId_slug_key" ON "Problem"("domainId", "slug");
CREATE INDEX "Problem_domainId_idx" ON "Problem"("domainId");
CREATE INDEX "Problem_isActive_idx" ON "Problem"("isActive");

-- CreateTable CatalogDiagnostic
CREATE TABLE "CatalogDiagnostic" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "problemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "confidence" TEXT,
    "difficulty" TEXT,
    "estimatedTime" TEXT,
    "internalNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogDiagnostic_problemId_slug_key" ON "CatalogDiagnostic"("problemId", "slug");
CREATE INDEX "CatalogDiagnostic_problemId_idx" ON "CatalogDiagnostic"("problemId");
CREATE INDEX "CatalogDiagnostic_isActive_idx" ON "CatalogDiagnostic"("isActive");

-- CreateTable CatalogIntervention
CREATE TABLE "CatalogIntervention" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "diagnosticId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "difficulty" TEXT,
    "estimatedTime" TEXT,
    "needsParts" BOOLEAN NOT NULL DEFAULT false,
    "partsNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogIntervention_diagnosticId_slug_key" ON "CatalogIntervention"("diagnosticId", "slug");
CREATE INDEX "CatalogIntervention_diagnosticId_idx" ON "CatalogIntervention"("diagnosticId");
CREATE INDEX "CatalogIntervention_isActive_idx" ON "CatalogIntervention"("isActive");

-- CreateTable Pricing
CREATE TABLE "Pricing" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "interventionId" TEXT NOT NULL,
    "minPrice" INTEGER,
    "referencePrice" INTEGER,
    "maxPrice" INTEGER,
    "technicianPrice" INTEGER,
    "customerPrice" INTEGER,
    "travelFee" INTEGER,
    "serviceFee" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "priceMode" TEXT NOT NULL DEFAULT 'fixed',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pricing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pricing_interventionId_key" ON "Pricing"("interventionId");
CREATE INDEX "Pricing_interventionId_idx" ON "Pricing"("interventionId");

-- CreateTable PricingHistory
CREATE TABLE "PricingHistory" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "pricingId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "previousValues" JSONB NOT NULL,
    "newValues" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingHistory_pricingId_idx" ON "PricingHistory"("pricingId");
CREATE INDEX "PricingHistory_adminId_idx" ON "PricingHistory"("adminId");

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "ServiceDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogDiagnostic" ADD CONSTRAINT "CatalogDiagnostic_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogIntervention" ADD CONSTRAINT "CatalogIntervention_diagnosticId_fkey" FOREIGN KEY ("diagnosticId") REFERENCES "CatalogDiagnostic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pricing" ADD CONSTRAINT "Pricing_interventionId_fkey" FOREIGN KEY ("interventionId") REFERENCES "CatalogIntervention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingHistory" ADD CONSTRAINT "PricingHistory_pricingId_fkey" FOREIGN KEY ("pricingId") REFERENCES "Pricing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingHistory" ADD CONSTRAINT "PricingHistory_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;