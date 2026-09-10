-- SPRINT 7 — Fondations opérationnelles : structure d'adresse / contact d'intervention.
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
-- Tous les nouveaux champs sont NULLABLES : les demandes existantes continuent
-- de fonctionner sans aucune action.

-- AlterTable
-- Quartier / secteur de l'intervention.
ALTER TABLE "Demande" ADD COLUMN "neighborhood" TEXT;

-- Point de repère pour aider à localiser le lieu (facultatif).
ALTER TABLE "Demande" ADD COLUMN "landmark" TEXT;

-- Numéro de téléphone de contact du client pour l'intervention (protégé,
-- exposé uniquement au client concerné et au technicien assigné).
ALTER TABLE "Demande" ADD COLUMN "contactPhone" TEXT;
