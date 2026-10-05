-- Chantier « Profil technicien complet + KYC dédié ».
--
-- NON DESTRUCTIF : uniquement des AJOUTS. Aucune colonne existante n'est
-- supprimée ni modifiée :
--   * `TechnicianProfile.experience` (texte libre) est CONSERVÉ ;
--   * `TechnicianProfile.categories` est CONSERVÉ et reste la base du
--     matching grossier ; `familyCodes` vient l'affiner, sans le remplacer.
-- Toutes les nouvelles colonnes sont nullables ou ont une valeur par défaut,
-- donc les techniciens existants restent valides (aucune rupture).
--
-- Idempotent : peut être relancé sans erreur si les objets existent déjà.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "KycIdentityDocumentType" AS ENUM ('NATIONAL_ID_CARD', 'PASSPORT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "KycDocumentSide" AS ENUM ('RECTO', 'VERSO', 'SINGLE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TechnicianActivityType" AS ENUM ('FREELANCE', 'SALARIED', 'COMPANY', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable TechnicianProfile : activité, expérience, compétences par
-- famille structurée.
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "activityType" "TechnicianActivityType";
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "experienceYears" INTEGER;
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "familyCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Contrôle de minorité : `experienceYears` reste cohérent avec la réalité.
DO $$ BEGIN
  ALTER TABLE "TechnicianProfile"
    ADD CONSTRAINT "TechnicianProfile_experienceYears_range"
    CHECK ("experienceYears" IS NULL OR ("experienceYears" >= 0 AND "experienceYears" <= 70));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable TechnicianProfile : identité KYC (page dédiée).
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "birthDate" DATE;
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "nationality" TEXT;
ALTER TABLE "TechnicianProfile" ADD COLUMN IF NOT EXISTS "kycIdentityDocType" "KycIdentityDocumentType";

-- Nationalité : code ISO 3166-1 alpha-2 en majuscules, longueur 2.
--
-- La liste des codes AUTORISÉS est validée côté applicatif
-- (`src/technician/nationalities.ts`, source unique partagée avec le frontend
-- via `GET /catalog/nationalities`). On ne fige ici que le format : figer les
-- 249 codes en SQL obligerait à une nouvelle migration à chaque ajout de pays
-- et créerait une deuxième source de vérité.
DO $$ BEGIN
  ALTER TABLE "TechnicianProfile"
    ADD CONSTRAINT "TechnicianProfile_nationality_format"
    CHECK ("nationality" IS NULL OR "nationality" ~ '^[A-Z]{2}$');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Index sur la date de naissance (contrôle de majorité + lecture backoffice).
CREATE INDEX IF NOT EXISTS "TechnicianProfile_birthDate_idx" ON "TechnicianProfile"("birthDate");

-- AlterTable KycDocument : face du document.
ALTER TABLE "KycDocument" ADD COLUMN IF NOT EXISTS "side" "KycDocumentSide" NOT NULL DEFAULT 'SINGLE';

-- Une seule pièce par (technicien, type, face) : repasser un recto remplace
-- le précédent côté service au lieu d'empiler les versions.
CREATE UNIQUE INDEX IF NOT EXISTS "KycDocument_technicianId_type_side_key"
  ON "KycDocument"("technicianId", "type", "side");