-- SPRINT 8.3 — Préparation opérationnelle de la mission : journal métier
-- (DemandeEvent) + notifications applicatives (Notification).
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive : aucune donnée
-- existante n'est modifiée ou supprimée.
--
-- 1. DemandeEventType : type d'événement métier d'une mission (création,
--    acceptation, diagnostic, tarifs, négociation, planification, transitions).
-- 2. NotificationType : motifs de notification applicative (créées uniquement
--    côté backend, jamais par le frontend).
-- 3. DemandeEvent : journal d'événements immutable d'une mission. actorUserId
--    est optionnel (événements système) ; fromStatus/toStatus ne sont
--    renseignés que pour les transitions de statut de la demande.
-- 4. Notification : notifications d'un utilisateur, liées optionnellement à
--    une mission (SetNull à la suppression de la demande : l'historique des
--    notifications est conservé). readAt null = non lue.

-- CreateEnum
CREATE TYPE "DemandeEventType" AS ENUM (
    'CREATED',
    'TECHNICIAN_ASSIGNED',
    'TECHNICIAN_ACCEPTED',
    'DIAGNOSTIC_SELECTED',
    'QUOTE_CREATED',
    'NEGOTIATION_REQUESTED',
    'QUOTE_ACCEPTED',
    'QUOTE_REJECTED',
    'SCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'CONFIRMED',
    'CANCELED'
);

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM (
    'TECHNICIAN_ACCEPTED',
    'QUOTE_CREATED',
    'NEGOTIATION_REQUESTED',
    'QUOTE_ACCEPTED',
    'QUOTE_REJECTED',
    'SCHEDULED',
    'COMPLETED',
    'CONFIRMED'
);

-- CreateTable DemandeEvent
CREATE TABLE "DemandeEvent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "demandeId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "DemandeEventType" NOT NULL,
    "fromStatus" "DemandeStatus",
    "toStatus" "DemandeStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemandeEvent_demandeId_createdAt_idx" ON "DemandeEvent"("demandeId", "createdAt");
CREATE INDEX "DemandeEvent_actorUserId_idx" ON "DemandeEvent"("actorUserId");

-- CreateTable Notification
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL,
    "demandeId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "DemandeEvent" ADD CONSTRAINT "DemandeEvent_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandeEvent" ADD CONSTRAINT "DemandeEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE SET NULL ON UPDATE CASCADE;