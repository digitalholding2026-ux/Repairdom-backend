-- MISSION #005 — Premier modèle métier réel.
-- Tables rédigées pour correspondre exactement au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway). Les mutations sont créées par
-- `prisma migrate deploy` via le start command du déploiement.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'TECHNICIAN');

-- CreateEnum
CREATE TYPE "DemandeStatus" AS ENUM ('SUBMITTED', 'PENDING', 'ACCEPTED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "role" "Role" NOT NULL DEFAULT 'CLIENT',
    "firstName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateTable
CREATE TABLE "Demande" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL,
    "status" "DemandeStatus" NOT NULL DEFAULT 'SUBMITTED',
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Demande_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Demande_reference_key" ON "Demande"("reference");

-- CreateIndex
CREATE INDEX "Demande_clientId_idx" ON "Demande"("clientId");

-- CreateTable
CREATE TABLE "DemandeMedia" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "kind" "MediaKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "stored" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "demandeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandeMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemandeMedia_demandeId_idx" ON "DemandeMedia"("demandeId");

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandeMedia" ADD CONSTRAINT "DemandeMedia_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE CASCADE ON UPDATE CASCADE;