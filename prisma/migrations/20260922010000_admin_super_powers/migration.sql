-- SPRINT ADMIN SUPER POWERS — Centre de contrôle back-office.
-- Migration strictement ADDITIVE et NON DESTRUCTIVE :
--
-- 1. User.isActive (BOOLEAN, défaut true) : désactivation logique des comptes
--    quand l'historique métier ou financier interdit une suppression physique.
--    Aucune ligne existante n'est modifiée au-delà du défaut (tous les comptes
--    restent actifs).
-- 2. NotificationType += ADMIN_MESSAGE (message direct de l'opérateur, sans
--    dossier lié).
--
-- Le retrait de fonds Relio (valeur `RELIO_WITHDRAWAL` et table
-- `RelioWithdrawal`) est reporté dans 20260927020000_add_relio_withdrawal : il
-- déclarait les types `FinancialTransactionType`, `FinancialTransactionMode` et
-- `FinancialTransactionStatus` alors que ceux-ci ne naissent que dans la
-- migration du moteur financier. Rejouée depuis une base vide, cette migration
-- levait donc « 42704 — type does not exist » et bloquait toute la chaîne.
--
-- Les deux instructions ci-dessous sont sous garde : une tentative antérieure
-- interrompue a pu laisser l'une d'elles derrière elle, PostgreSQL n'annulant
-- pas l'ajout d'une valeur d'énumération quand la transaction échoue ensuite.

-- AlterEnum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationType' AND e.enumlabel = 'ADMIN_MESSAGE') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'ADMIN_MESSAGE';
    END IF;
END $$;

-- AlterTable User : ajout de la désactivation logique (défaut : actif).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
