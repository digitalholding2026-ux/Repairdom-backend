-- SPRINT 4 — Profil professionnel technicien + fondations KYC manuel.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
-- Tous les nouveaux champs ont des valeurs sûres par défaut : les techniciens
-- existants continuent de fonctionner sans aucune action.

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "TechnicianProfile" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "bio" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "experience" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "serviceDescription" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "specialties" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TechnicianProfile" ADD COLUMN "kycStatus" "KycStatus" NOT NULL DEFAULT 'NOT_SUBMITTED';