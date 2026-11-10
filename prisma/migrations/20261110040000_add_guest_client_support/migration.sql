-- M2 — support client invité (guest client).
--
-- Contexte : les services FRP et Système n'exigent plus la création de
-- compte avec mot de passe. Une demande peut être déposée anonymement et
-- liée soit à un utilisateur existant (recherche par téléphone), soit à un
-- nouvel utilisateur "fantôme" sans mot de passe.
--
-- Cette migration :
--  1. Rend `User.passwordHash` nullable (utilisateur fantôme sans mot de passe).
--  2. Ajoute `Demande.trackingToken` (UUID unique) pour le suivi public
--     anonyme via `/suivi/[token]`.

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "trackingToken" TEXT UNIQUE;
