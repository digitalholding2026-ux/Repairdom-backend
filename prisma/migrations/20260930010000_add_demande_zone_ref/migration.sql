-- SPRINT 8.8.2 — Rattachement structuré des demandes à une zone RepairDom.
-- Migration strictement ADDITIVE et NON DESTRUCTIVE.
--
-- 1. Demande.zoneId : référence NULLABLE vers Zone (quartier/secteur
--    structuré). Les demandes existantes restent lisibles et obtiennent
--    implicitement zoneId = NULL (aucun DEFAULT imposé, aucune réécriture).
-- 2. ON DELETE SET NULL : supprimer une zone du référentiel ne casse jamais
--    une mission (les snapshots texte Demande.city / Demande.neighborhood
--    restent intacts, comme pour Demande.cityId en Sprint 8.7).
-- 3. AUCUN backfill automatique depuis `neighborhood` ou `address` : le
--    quartier reste un texte libre historique ; seul le backend (règle E du
--    sprint) renseigne zoneId pour les nouvelles demandes explicitement zonées.
-- 4. Aucun champ existant n'est supprimé ni renommé.

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "zoneId" TEXT;

-- CreateIndex
CREATE INDEX "Demande_zoneId_idx" ON "Demande"("zoneId");

-- AddForeignKey
ALTER TABLE "Demande" ADD CONSTRAINT "Demande_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
