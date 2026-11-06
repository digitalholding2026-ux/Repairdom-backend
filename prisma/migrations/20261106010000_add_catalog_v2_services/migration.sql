-- M1 — Catalogue Relio v2 : prestations, catégories, items et leurs deux prix.
--
-- NON DESTRUCTIVE : deux types énumérés neufs, trois tables neuves et une
-- colonne additive nullable sur `User`. Aucune table existante n'est modifiée
-- ni supprimée, aucune donnée historique n'est touchée. Le catalogue
-- historique (ServiceDomain / DeviceBrand / DeviceModel / Problem /
-- CatalogIntervention / Pricing) reste en place.
--
-- `User.clientType` vaut CLIENT par défaut : les comptes existants conservent
-- donc la lecture du tarif public, exactement leur comportement d'aujourd'hui.
--
-- Idempotent : peut être relancé sans erreur si les objets existent déjà.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Types énumérés
-- ─────────────────────────────────────────────────────────────────────────

-- CreateEnum ClientType
DO $$ BEGIN
    CREATE TYPE "public"."ClientType" AS ENUM ('CLIENT', 'B2B');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum ServiceCode
DO $$ BEGIN
    CREATE TYPE "public"."ServiceCode" AS ENUM ('SYSTEME', 'SMARTPHONE', 'FRP');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Tables du catalogue
-- ─────────────────────────────────────────────────────────────────────────

-- CreateTable Service
CREATE TABLE IF NOT EXISTS "Service" (
    "id" TEXT NOT NULL,
    "code" "public"."ServiceCode" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable CatalogCategory
CREATE TABLE IF NOT EXISTS "CatalogCategory" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable CatalogItem
CREATE TABLE IF NOT EXISTS "CatalogItem" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "androidVersion" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "pricePublic" INTEGER,
    "pricePro" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Service_code_key" ON "Service"("code");
CREATE INDEX IF NOT EXISTS "Service_active_idx" ON "Service"("active");
CREATE UNIQUE INDEX IF NOT EXISTS "CatalogCategory_serviceId_code_key" ON "CatalogCategory"("serviceId", "code");
CREATE INDEX IF NOT EXISTS "CatalogCategory_serviceId_active_order_idx" ON "CatalogCategory"("serviceId", "active", "order");
CREATE UNIQUE INDEX IF NOT EXISTS "CatalogItem_categoryId_code_key" ON "CatalogItem"("categoryId", "code");
CREATE INDEX IF NOT EXISTS "CatalogItem_categoryId_active_order_idx" ON "CatalogItem"("categoryId", "active", "order");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CatalogCategory" ADD CONSTRAINT "CatalogCategory_serviceId_fkey"
        FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_categoryId_fkey"
        FOREIGN KEY ("categoryId") REFERENCES "CatalogCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. User : nature commerciale du compte
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "clientType" "public"."ClientType" NOT NULL DEFAULT 'CLIENT';
