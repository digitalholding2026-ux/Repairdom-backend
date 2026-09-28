-- GPS V3 — localisation temporaire de deplacement liee a la mission
-- (« technicien en route »). Migration strictement ADDITIVE et NON DESTRUCTIVE.
--
-- 1. Demande.travelLatitude / travelLongitude (DOUBLE PRECISION, NULLABLE) +
--    travelLocationUpdatedAt (NULLABLE) : position de deplacement transmise
--    explicitement par le technicien assigne (« Je suis en route », puis
--    actualisations volontaires). Chaque transmission ecrase la precedente :
--    aucun historique, aucun tracking, aucun WebSocket.
-- 2. Demande.technicianEnRouteAt / technicianArrivedAt (NULLABLE) : debut et
--    fin du deplacement. `technicianArrivedAt` renseigne = deplacement clos
--    (la position de deplacement n'est plus exposee comme active).
-- 3. DemandeEventType += TECHNICIAN_EN_ROUTE / TECHNICIAN_ARRIVED (journal
--    metier informatif, aucun changement de statut).
-- 4. NotificationType += TECHNICIAN_EN_ROUTE (notifiee au client de la
--    mission uniquement).
-- 5. Aucune contrainte CHECK en base (bornes -90..90 / -180..180 validees
--    cote API) ; aucun index (pas de requete geospatiale, le matching
--    dispatch reste city/zone/category) ; aucun champ existant supprime
--    ni renomme.

-- AlterTable
ALTER TABLE "Demande" ADD COLUMN "travelLatitude" DOUBLE PRECISION;
ALTER TABLE "Demande" ADD COLUMN "travelLongitude" DOUBLE PRECISION;
ALTER TABLE "Demande" ADD COLUMN "travelLocationUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Demande" ADD COLUMN "technicianEnRouteAt" TIMESTAMP(3);
ALTER TABLE "Demande" ADD COLUMN "technicianArrivedAt" TIMESTAMP(3);

-- AlterEnum
ALTER TYPE "DemandeEventType" ADD VALUE 'TECHNICIAN_EN_ROUTE';
ALTER TYPE "DemandeEventType" ADD VALUE 'TECHNICIAN_ARRIVED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TECHNICIAN_EN_ROUTE';
