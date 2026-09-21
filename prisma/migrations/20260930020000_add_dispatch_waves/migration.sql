-- SPRINT DISPATCH-V1 — Suivi des vagues de dispatch intelligent.
-- Migration strictement ADDITIVE et NON DESTRUCTIVE.
--
-- 1. DispatchWave : une ligne = un technicien contacté (demande, vague,
--    canal). Source de vérité anti-doublon via
--    UNIQUE (demandeId, wave, userId, channel) : redémarrage Railway, double
--    exécution du scheduler et relance accidentelle ne créent jamais de
--    doublon. ON DELETE CASCADE des deux côtés : aucune suppression bloquée.
-- 2. NotificationType += MISSION_AVAILABLE (nouvelle mission proposée,
--    antérieure à toute acceptation).
-- 3. DemandeEventType += DISPATCH_WAVE (traçabilité des vagues, metadata
--    { wave, candidateCount }).
-- 4. Aucune table/colonne existante modifiée, aucune donnée réécrite.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MISSION_AVAILABLE';

-- AlterEnum
ALTER TYPE "DemandeEventType" ADD VALUE 'DISPATCH_WAVE';

-- CreateTable DispatchWave
CREATE TABLE "DispatchWave" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "demandeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wave" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchWave_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DispatchWave_demandeId_wave_userId_channel_key" ON "DispatchWave"("demandeId", "wave", "userId", "channel");
CREATE INDEX "DispatchWave_demandeId_wave_idx" ON "DispatchWave"("demandeId", "wave");
CREATE INDEX "DispatchWave_wave_sentAt_idx" ON "DispatchWave"("wave", "sentAt");

-- AddForeignKey
ALTER TABLE "DispatchWave" ADD CONSTRAINT "DispatchWave_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchWave" ADD CONSTRAINT "DispatchWave_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
