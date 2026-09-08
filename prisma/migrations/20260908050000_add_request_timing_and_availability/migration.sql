-- SPRINT 3 — Le client exprime quand il souhaite être dépanné (ASAP / planifié)
-- et disponibilité explicite du technicien.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.

-- CreateEnum
CREATE TYPE "RequestTiming" AS ENUM ('ASAP', 'SCHEDULED');

-- AlterTable
-- Préférence temporelle du client : « Dès que possible » (ASAP) ou date/heure souhaitée.
ALTER TABLE "Demande" ADD COLUMN "requestedMode" "RequestTiming" NOT NULL DEFAULT 'ASAP';
ALTER TABLE "Demande" ADD COLUMN "requestedAt" TIMESTAMP(3);

-- AlterTable
-- Disponibilité explicite du technicien (signal de priorité, indépendant du statut des missions).
ALTER TABLE "TechnicianProfile" ADD COLUMN "isAvailable" BOOLEAN NOT NULL DEFAULT false;