-- SPRINT 8.7 — Référentiel géographique structuré RepairDom.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), NON DESTRUCTIVE.
--
-- 1. Zone : quartiers/secteurs rattachés à une ServiceCity (slug unique par ville).
-- 2. TechnicianZoneCoverage : couverture technicien N↔N (structure seule, aucun
--    matching dans ce sprint).
-- 3. User.cityId / TechnicianProfile.cityId / Demande.cityId : références
--    NULLABLES vers ServiceCity. Les chaînes textuelles existantes (User.city,
--    TechnicianProfile.city, Demande.city) ne sont JAMAIS supprimées ni
--    modifiées : elles restent la source d'affichage et le snapshot historique.
--    ON DELETE SET NULL : supprimer une ville du référentiel ne casse jamais
--    une ancienne mission (le snapshot texte reste intact).
-- 4. Backfill non destructif : résolution des chaînes existantes vers le
--    ServiceCity correspondant par normalisation STRICTE (minuscules + accents
--    simples + suppression des espaces). Aucune correspondance floue : si la
--    chaîne normalisée ne correspond pas exactement à un slug/nom, cityId reste
--    NULL et la chaîne originale est conservée.

-- CreateTable Zone
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "cityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Zone_cityId_slug_key" ON "Zone"("cityId", "slug");
CREATE INDEX "Zone_cityId_idx" ON "Zone"("cityId");
CREATE INDEX "Zone_isActive_idx" ON "Zone"("isActive");

-- CreateTable TechnicianZoneCoverage
CREATE TABLE "TechnicianZoneCoverage" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "technicianProfileId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicianZoneCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TechnicianZoneCoverage_technicianProfileId_zoneId_key" ON "TechnicianZoneCoverage"("technicianProfileId", "zoneId");
CREATE INDEX "TechnicianZoneCoverage_zoneId_idx" ON "TechnicianZoneCoverage"("zoneId");

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "ServiceCity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianZoneCoverage" ADD CONSTRAINT "TechnicianZoneCoverage_technicianProfileId_fkey" FOREIGN KEY ("technicianProfileId") REFERENCES "TechnicianProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianZoneCoverage" ADD CONSTRAINT "TechnicianZoneCoverage_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- Références structurées NULLABLES vers ServiceCity (transition).
ALTER TABLE "User" ADD COLUMN "cityId" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN "cityId" TEXT;
ALTER TABLE "Demande" ADD COLUMN "cityId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "ServiceCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicianProfile" ADD CONSTRAINT "TechnicianProfile_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "ServiceCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "ServiceCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill non destructif ──────────────────────────────────────────────
-- Normalisation stricte N(x) : minuscules, accents « de base » replacés par leur
-- lettre sans accent, suppression de tous les espaces. La correspondance se fait
-- sur l'égalité exacte avec le slug (forme canonique) ou avec le nom normalisé.
-- Toute chaîne non résolue de façon certaine reste avec cityId NULL.
-- Les chaînes originales ne sont jamais modifiées.

-- Backfill: User.city → ServiceCity.id
UPDATE "User" u
SET "cityId" = s."id"
FROM "ServiceCity" s
WHERE u."cityId" IS NULL
  AND u."city" IS NOT NULL
  AND (
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(u."city"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
    OR
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(s."name"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
  );

-- Backfill: TechnicianProfile.city → ServiceCity.id
UPDATE "TechnicianProfile" tp
SET "cityId" = s."id"
FROM "ServiceCity" s
WHERE tp."cityId" IS NULL
  AND (
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(tp."city"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
    OR
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(s."name"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
  );

-- Backfill: Demande.city → ServiceCity.id (snapshot texte strictement conservé)
UPDATE "Demande" d
SET "cityId" = s."id"
FROM "ServiceCity" s
WHERE d."cityId" IS NULL
  AND (
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(d."city"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
    OR
    s."slug" = regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(lower(s."name"),
          'é','e'),'è','e'),'ê','e'),'ë','e'),
          'à','a'),'â','a'),'î','i'),'ï','i'),
          'ù','u'),'û','u'),'ô','o'),'ö','o'),'ç','c'),
      '\s', '', 'g')
  );