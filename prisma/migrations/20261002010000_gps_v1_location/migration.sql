-- GPS V1 — capture de position (localisation + derniere position + distance).
-- Migration strictement ADDITIVE et NON DESTRUCTIVE.
--
-- 1. Demande.latitude / Demande.longitude (DOUBLE PRECISION, NULLABLE) :
--    position de la demande transmise a la creation. Les demandes existantes
--    restent lisibles et obtiennent implicitement NULL (aucun DEFAULT impose,
--    aucune reecriture, aucun backfill).
-- 2. TechnicianProfile.lastLatitude / lastLongitude (NULLABLE) +
--    locationUpdatedAt (NULLABLE) : derniere position explicitement transmise
--    par le technicien. Pas d'historique : chaque transmission ecrase la
--    precedente. `locationUpdatedAt` est distinct de `updatedAt` (qui suit
--    toute modification du profil).
-- 3. Aucune contrainte CHECK en base (les bornes -90..90 / -180..180 sont
--    validees cote API) ; aucun index (pas de requete geospatiale en V1, le
--    matching dispatch reste city/zone/category) ; aucun champ existant
--    supprime ni renomme.

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Demande" ADD COLUMN "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "TechnicianProfile" ADD COLUMN "lastLatitude" DOUBLE PRECISION;
ALTER TABLE "TechnicianProfile" ADD COLUMN "lastLongitude" DOUBLE PRECISION;
ALTER TABLE "TechnicianProfile" ADD COLUMN "locationUpdatedAt" TIMESTAMP(3);
