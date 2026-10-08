-- Chantier 4-FONDATIONS-C — REFONTE LTV du programme de récompenses client.
--
-- Le programme #4A (compteur de MISSIONS, paliers BRONZE/ARGENT/OR/PLATINE à
-- 15/50/150/500 missions) est SUPPRIMÉ : il était économiquement
-- insoutenable avec le barème « 500 FCFA + 4 % » livré au chantier
-- 4-FONDATIONS-A (un client très actif coûtait à Relio bien plus que ses
-- récompenses). Il est remplacé par un modèle basé sur la MARGE CUMULÉE.
--
-- ── Suppression SANS perte ───────────────────────────────────────────
-- Aucun client en base ne dispose de progression #4A (le programme n'a jamais
-- étéependent en production), donc ni la table ni l'enum `RewardTier` ne
-- portent de données à migrer. Le `DROP` est donc direct : aucun `ALTER
-- COLUMN ... TYPE`, aucun backfill, aucun risque de perte.
--
-- L'ordre est IMPÉRATIF : la table est supprimée EN PREMIER (elle référence
-- l'enum `RewardTier` par une colonne simple ET par deux colonnes tableau),
-- l'enum ne peut être recréée qu'ensuite.
--
-- PostgreSQL ne permet pas de retirer une valeur d'un enum ; on recrée donc
-- le type. `CASCADE` n'est pas utilisé : on veut qu'une dépendance oubliée
-- fasse ÉCHOUER la migration plutôt que de supprimer autre chose par surprise.

-- 1) Suppression de l'ancien modèle (#4A).
DROP TABLE IF EXISTS "ClientRewardProgress";
DROP TYPE IF EXISTS "RewardTier";

-- 2) Enums du nouveau modèle LTV.
CREATE TYPE "RewardTier" AS ENUM ('NONE', 'FIDELE', 'OR', 'PLATINE');
CREATE TYPE "NatureRewardTier" AS ENUM ('NONE', 'ELECTROMENAGER_PETIT', 'ELECTROMENAGER_MOYEN', 'SMARTPHONE');

-- 3) Nouvelle table de progression LTV.
--    `cumulativeMarginXAF` : marge cumulée à vie, ENTIER XAF (règle FCFA —
--    aucun montant formaté n'est stocké).
--    `creditsEarned` est dérivé de la marge (floor(marge / 10 000) x 500),
--    `creditsClaimed` est ce qui a déjà été versé au solde.
--    `natureReached` / `natureClaimed` : récompenses nature cumulables.
CREATE TABLE "ClientRewardProgress" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "cumulativeMarginXAF" INTEGER NOT NULL DEFAULT 0,
    "currentTier" "RewardTier" NOT NULL DEFAULT 'NONE',
    "currentNatureTier" "NatureRewardTier" NOT NULL DEFAULT 'NONE',
    "creditsEarned" INTEGER NOT NULL DEFAULT 0,
    "creditsClaimed" INTEGER NOT NULL DEFAULT 0,
    "lastCreditClaimAt" TIMESTAMP(3),
    "natureReached" "NatureRewardTier"[] DEFAULT ARRAY[]::"NatureRewardTier"[],
    "natureClaimed" "NatureRewardTier"[] DEFAULT ARRAY[]::"NatureRewardTier"[],
    "lastMissionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRewardProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex : un client n'a qu'une seule ligne de progression.
CREATE UNIQUE INDEX "ClientRewardProgress_userId_key" ON "ClientRewardProgress"("userId");

-- AddForeignKey : suppression du compte → suppression de sa progression.
ALTER TABLE "ClientRewardProgress" ADD CONSTRAINT "ClientRewardProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;