-- Chantier #4A — Programme de récompenses client : tables et enum de base.
--
-- Cette migration est STRICTEMENT additive (aucune colonne modifiée, aucune
-- donnée existante touchée) : la.tables sont créées vides et la progression
-- de chaque client commence à 0. Les clients qui ont déjà réalisé des
-- missions CONFIRMED avant cette mise en production ne sont donc PAS
-- rétro-alimentés — le compteur démarre à zéro et se construisent à partir des
-- prochaines confirmations. C'est un choix assumé (un backfill aurait exigé de
-- rejouer l'historique de règlements, avec un risque de double comptage).
--
-- L'ajout des valeurs de l'enum `NotificationType` est volontairement
-- reporté dans la migration suivante `20261013020000_add_reward_notification_types` :
-- `ALTER TYPE ... ADD VALUE` ne peut pas être exécuté dans une transaction sur
-- les anciennes versions de PostgreSQL, il mérite donc son propre fichier.
CREATE TYPE "RewardTier" AS ENUM ('NONE', 'BRONZE', 'ARGENT', 'OR', 'PLATINE');

-- CreateTable
CREATE TABLE "ClientRewardProgress" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "missionCount" INTEGER NOT NULL DEFAULT 0,
    "currentTier" "RewardTier" NOT NULL DEFAULT 'NONE',
    "reachedTiers" "RewardTier"[] DEFAULT ARRAY[]::"RewardTier"[],
    "claimedTiers" "RewardTier"[] DEFAULT ARRAY[]::"RewardTier"[],
    "lastMissionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRewardProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardFraudFlag" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "demandeId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "decision" TEXT,
    "note" TEXT,

    CONSTRAINT "RewardFraudFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientRewardProgress_userId_key" ON "ClientRewardProgress"("userId");

-- Une mission ne peut être signalée qu'une fois : garantie de base contre un
-- double gel du compteur client (le service est lui-même idempotent).
CREATE UNIQUE INDEX "RewardFraudFlag_demandeId_key" ON "RewardFraudFlag"("demandeId");

-- CreateIndex
CREATE INDEX "RewardFraudFlag_userId_idx" ON "RewardFraudFlag"("userId");

-- CreateIndex
CREATE INDEX "RewardFraudFlag_resolvedAt_idx" ON "RewardFraudFlag"("resolvedAt");

-- AddForeignKey
ALTER TABLE "ClientRewardProgress" ADD CONSTRAINT "ClientRewardProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardFraudFlag" ADD CONSTRAINT "RewardFraudFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardFraudFlag" ADD CONSTRAINT "RewardFraudFlag_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardFraudFlag" ADD CONSTRAINT "RewardFraudFlag_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
