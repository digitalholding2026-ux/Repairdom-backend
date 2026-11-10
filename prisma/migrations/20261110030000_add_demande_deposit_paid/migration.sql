-- M2 — colonnes depositPaid et isNoShow manquantes sur Demande.
--
-- Contexte : le schéma Prisma déclare `Demande.depositPaid` (boolean, défaut false)
-- et `Demande.isNoShow` (boolean, défaut false), mais aucune migration ne les a
-- créées en production. La base de production est en drift et l'EscrowCronService
-- échoue avec P2022 (colonne introuvable) dès qu'il lit ces champs.
--
-- Cette migration ajoute les deux colonnes de façon idempotente.

ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "depositPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "isNoShow" BOOLEAN NOT NULL DEFAULT false;
