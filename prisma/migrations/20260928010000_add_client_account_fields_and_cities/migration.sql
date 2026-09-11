-- SPRINT UX CLIENT — Champs de compte client + zones de service (villes).
--
-- 1) Profil & vérification email du client :
--    - city / address / whatsapp / avatarUrl : profil enrichi du client,
--      renseignés à l'inscription (catalogue de villes) et modifiables
--      via PATCH /auth/me / POST /auth/me/avatar ;
--    - emailVerified (Boolean NOT NULL DEFAULT true) : les comptes existants
--      restent vérifiés (aucun blocage en production), seuls les NOUVEAUX
--      inscrits CLIENT doivent confirmer leur adresse avant de se connecter ;
--    - emailVerificationToken + emailVerificationExpiresAt : jeton
--      d'activation (24 h) généré au register CLIENT.
--
-- NON DESTRUCTIVE : uniquement des colonnes/table nouvelles et du seed initial
-- de villes camerounaises. Aucune donnée existante n'est altérée.

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "city" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "emailVerificationToken" TEXT,
  ADD COLUMN "emailVerificationExpiresAt" TIMESTAMP(3);

-- CreateTable ServiceCity (catalogue des zones de service)
CREATE TABLE "ServiceCity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCity_slug_key" ON "ServiceCity"("slug");

-- Seed initial : principales villes camerounaises couvertes par RepairDom.
INSERT INTO "ServiceCity" ("id", "name", "slug", "isActive", "sortOrder", "updatedAt") VALUES
  (gen_random_uuid(), 'Yaoundé', 'yaounde', true, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Douala', 'douala', true, 2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Bafoussam', 'bafoussam', true, 3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Bamenda', 'bamenda', true, 4, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Buéa', 'buea', true, 5, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Limbe', 'limbe', true, 6, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Garoua', 'garoua', true, 7, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Maroua', 'maroua', true, 8, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Ngaoundéré', 'ngaoundere', true, 9, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Bertoua', 'bertoua', true, 10, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Édéa', 'edea', true, 11, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Kribi', 'kribi', true, 12, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Dschang', 'dschang', true, 13, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Kumba', 'kumba', true, 14, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Ebolowa', 'ebolowa', true, 15, CURRENT_TIMESTAMP);