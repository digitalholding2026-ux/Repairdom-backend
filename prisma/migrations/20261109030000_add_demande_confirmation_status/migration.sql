-- RÉCUPÉRATION — colonne confirmationStatus manquante sur Demande.
--
-- Contexte : la base de production est en drift. La colonne
-- `Demande.confirmationStatus` est déclarée dans schema.prisma (M2 —
-- statut de confirmation du rendez-vous par WhatsApp) mais aucune migration
-- ne l'a créée en production. EscrowCronService lit cette colonne et échoue
-- avec P2022 (colonne introuvable).
--
-- Cette migration ajoute l'ENUM et la colonne avec des gardes d'idempotence,
-- de sorte qu'elle peut être relancée sans risque sur la base de production
-- existante.

-- --- Énumération ConfirmationStatus (idempotente) --------------------------

DO $$ BEGIN
  CREATE TYPE "ConfirmationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED_BY_ADMIN', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- --- Colonne confirmationStatus sur Demande --------------------------------

ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "confirmationStatus" "ConfirmationStatus" NOT NULL DEFAULT 'PENDING';

-- Garantir que les lignes existantes ont PENDING (sécurité si la colonne
-- existait déjà avec des NULL, bien que DEFAULT s'en charge à l'ajout).
UPDATE "Demande" SET "confirmationStatus" = 'PENDING' WHERE "confirmationStatus" IS NULL;
