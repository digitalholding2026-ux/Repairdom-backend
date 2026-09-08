-- SPRINT 1 — Cycle de vie de la mission après acceptation :
-- SUBMITTED → ACCEPTED → SCHEDULED → IN_PROGRESS → COMPLETED → CONFIRMED (+ CANCELED).
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.

-- AlterEnum
ALTER TYPE "DemandeStatus" ADD VALUE 'SCHEDULED';
ALTER TYPE "DemandeStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "DemandeStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "DemandeStatus" ADD VALUE 'CONFIRMED';

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "scheduledAt" TIMESTAMP(3);