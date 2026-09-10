-- SPRINT 8.4 — Gouvernance du diagnostic : le backend est la seule autorité.
-- Un diagnostic (catalogue ou non référencé) et un tarif manuel ne sont
-- possibles qu'une fois la mission acceptée (Demande.status = ACCEPTED).
-- Le diagnostic non référencé (MANUAL) est explicitement identifié et enrichi
-- (intervention proposée, justification, note libre), avec une trace
-- d'événement dédiée MANUAL_DIAGNOSTIC_DECLARED (distincte de
-- DIAGNOSTIC_SELECTED du catalogue). Rédigée manuellement pour correspondre
-- au DDL généré par Prisma 7 (migrate deploy sur PostgreSQL Railway).
-- Non destructive : aucune donnée existante n'est supprimée.
--
-- 1. DiagnosticMode : CATALOG (diagnostic sélectionné dans le catalogue
--    RepairDom, pricing auto) / MANUAL (diagnostic non référencé déclaré
--    librement par le technicien, tarif manuel).
-- 2. Diagnostic : colonnes mode / proposedIntervention / justification / notes.
--    Backfill : diagnostics déjà liés au catalogue → CATALOG.
-- 3. DemandeEventType : ajout de MANUAL_DIAGNOSTIC_DECLARED.

-- CreateEnum
CREATE TYPE "DiagnosticMode" AS ENUM ('CATALOG', 'MANUAL');

-- AlterTable Diagnostic
ALTER TABLE "Diagnostic" ADD COLUMN "mode" "DiagnosticMode" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Diagnostic" ADD COLUMN "proposedIntervention" TEXT;
ALTER TABLE "Diagnostic" ADD COLUMN "justification" TEXT;
ALTER TABLE "Diagnostic" ADD COLUMN "notes" TEXT;

-- Backfill : les diagnostics issus du catalogue (Sprint 8.1, catalogDiagnosticId
-- renseigné) sont marqués CATALOG ; les autres restent MANUAL par défaut.
UPDATE "Diagnostic"
SET "mode" = 'CATALOG'
WHERE "catalogDiagnosticId" IS NOT NULL;

-- AlterEnum DemandeEventType
ALTER TYPE "DemandeEventType" ADD VALUE 'MANUAL_DIAGNOSTIC_DECLARED';