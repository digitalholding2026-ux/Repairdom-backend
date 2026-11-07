-- M1 — Éligibilité professionnelle par prestation.
--
-- ADDITIVE : une colonne neuve avec défaut true, aucune donnée historique
-- touchée. Les prestations existantes restent donc servies aux comptes B2B
-- jusqu'à ce que le seed déclare le contraire (SMARTPHONE réservée aux
-- particuliers via proAvailable = false).
--
-- Idempotent : peut être relancée sans erreur si la colonne existe déjà.

ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "proAvailable" BOOLEAN NOT NULL DEFAULT true;