-- Chantier D2.5 — relances automatiques de vérification d'e-mail (J+1, J+3, J+7).
--
-- Deux colonnes sur `User` :
--  - `verificationReminderCount` sert d'index de fenêtre (0/1/2) ET de
--    compteur de relances : à 3, le scheduler arrête définitivement.
--  - `lastVerificationReminderAt` permet d'exiger 20 h entre deux envois
--    (garde anti-doublon sur le balayage horaire).
--
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` : la migration reste rejouable
-- sans effet de bord si une colonne existe déjà, comme le reste du dépôt.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "verificationReminderCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastVerificationReminderAt" TIMESTAMP(3);

-- Le balayage filtre systématiquement sur `emailVerified = false` ET sur la
-- fenêtre de `createdAt`. Un index partiel ne sert donc QUE ce balayage
-- (horaire) : les autres requêtes sur `User` (par `email`, par `cityId`) ne
-- le traversent pas, le préfixe `emailVerified` les élimine d'emblée.
CREATE INDEX IF NOT EXISTS "User_pending_verification_idx"
    ON "User"("createdAt")
    WHERE "emailVerified" = false;