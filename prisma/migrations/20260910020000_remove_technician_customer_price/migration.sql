-- SPRINT 8 — Simplification du modèle tarifaire.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7.
--
-- Supprime les prix technicien/client internes du modèle Pricing :
--   * technicianPrice -> supprimé (info interne redondante, non utilisée)
--   * customerPrice   -> supprimé (le client ne voit que referencePrice + travelFee)
--
-- Scope : ADMIN + catalogue omniprésent ; aucun autre module (Quote, mission,
-- tracking, réputation) n'utilise ces deux colonnes.

-- AlterTable
ALTER TABLE "Pricing" DROP COLUMN "technicianPrice";
ALTER TABLE "Pricing" DROP COLUMN "customerPrice";