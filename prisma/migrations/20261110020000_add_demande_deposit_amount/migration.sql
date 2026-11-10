-- M2 — colonne depositAmount manquante sur Demande.
--
-- Contexte : le schéma Prisma déclare `Demande.depositAmount` (frais de
-- déplacement réservés à la validation, ex. 1 000 XAF pour FRP / Système),
-- mais aucune migration ne l'a créée en production. La base de production est
-- donc en drift et l'EscrowCronService échoue avec P2022 (colonne
-- introuvable).
--
-- Cette migration ajoute la colonne de façon idempotente.

ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "depositAmount" INTEGER;
