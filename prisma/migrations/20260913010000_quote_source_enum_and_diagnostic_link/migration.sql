-- SPRINT 8.6 — Fiabilisation des données tarifaires.
--
-- 1. Quote.source : colonne TEXT libre → énumération Prisma "QuoteSource"
--    (CATALOG / MANUAL). La conversion est explicite et surveillée : toute
--    valeur inattendue fait ABORTER la migration avant tout changement
--    (aucune donnée n'est renommée, normalisée ou supprimée silencieusement).
-- 2. Quote.diagnosticId : lien nullable vers le Diagnostic de mission qui
--    motive le tarif (traçabilité CATALOG / MANUAL : mode, intervention
--    proposée, justification, notes). Backfill non destructif : chaque quote
--    est rattachée à son dernier diagnostic (même mission, même technicien) ;
--    les propositions sans diagnostic (missions antérieures) restent NULL.
--
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (prisma migrate deploy sur PostgreSQL Railway). Non destructive :
-- aucune donnée existante n'est supprimée.

-- Garde de défense avant conversion : toute valeur hors {CATALOG, MANUAL}
-- interrompt la migration sans modifier les données.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Quote" WHERE "source" NOT IN ('CATALOG', 'MANUAL')
  ) THEN
    RAISE EXCEPTION
      'Valeurs inattendues détectées dans Quote.source : conversion en énumération QuoteSource impossible. Aucune donnée n''a été modifiée.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "QuoteSource" AS ENUM ('CATALOG', 'MANUAL');

-- AlterTable Quote (TEXT → enum QuoteSource)
ALTER TABLE "Quote" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "Quote" ALTER COLUMN "source" TYPE "QuoteSource" USING ("source"::"QuoteSource");
ALTER TABLE "Quote" ALTER COLUMN "source" SET DEFAULT 'MANUAL';

-- AlterTable Quote (lien au diagnostic de mission)
ALTER TABLE "Quote" ADD COLUMN "diagnosticId" TEXT;

-- Backfill (non destructif) : rattache chaque quote à son dernier diagnostic
-- rédigé pour la même mission par le même technicien (parcours catalogue et
-- non référencé). Les propositions anciennes n'ayant aucun diagnostic
-- conservent la valeur NULL.
UPDATE "Quote" q
SET "diagnosticId" = d.id
FROM (
  SELECT DISTINCT ON ("demandeId", "technicianId") "id", "demandeId", "technicianId"
  FROM "Diagnostic"
  ORDER BY "demandeId", "technicianId", "createdAt" DESC
) d
WHERE q."diagnosticId" IS NULL
  AND q."demandeId" = d."demandeId"
  AND q."technicianId" = d."technicianId";

-- CreateIndex
CREATE INDEX "Quote_diagnosticId_idx" ON "Quote"("diagnosticId");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_diagnosticId_fkey"
  FOREIGN KEY ("diagnosticId") REFERENCES "Diagnostic"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;