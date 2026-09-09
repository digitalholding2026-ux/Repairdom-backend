-- CORRECTION — Sprint 5.1 : la migration 20260909010000 omettait
-- `DEFAULT gen_random_uuid()` sur KycDocument.id, aligné sur le reste du
-- schéma (`id String @id @default(dbgenerated("gen_random_uuid()"))`).
-- Résultat : tout `kycDocument.create` violait la contrainte NOT NULL sur
-- "id" -> erreur Prisma P2011 -> 500 générique en production.
-- Migration NON destructive : ajoute uniquement la valeur par défaut.
-- (La migration déjà appliquée 20260909010000 n'est PAS modifiée : Prisma
-- vérifie son checksum et la modifier ferait échouer `prisma migrate deploy`.)

-- AlterTable
ALTER TABLE "KycDocument" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();