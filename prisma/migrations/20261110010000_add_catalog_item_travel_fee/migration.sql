-- M2 — colonne travelFee manquante sur CatalogItem.
--
-- Contexte : le schéma Prisma déclare `CatalogItem.travelFee` (frais de
-- déplacement applicables à l'item, ex. 1 000 XAF pour le déblocage FRP /
-- Système), mais la migration 20261106010000_add_catalog_v2_services a créé
-- la table sans cette colonne. La base de production est donc en drift et le
-- seed du catalogue v2 échoue avec P2022 (colonne introuvable).
--
-- Cette migration ajoute la colonne de façon idempotente.

ALTER TABLE "CatalogItem" ADD COLUMN IF NOT EXISTS "travelFee" INTEGER;
