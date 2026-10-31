-- M0.2 — Retrait du domaine « technicien » du schéma (Relio v2).
--
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), en suivant le style des
-- migrations existantes (noms d'index / contraintes identiques à Prisma).
--
-- CE QUE FAIT CETTE MIGRATION
--   1. Enum `Role` : retrait de la valeur `TECHNICIAN` (reste CLIENT, ADMIN).
--   2. Suppression des tables du domaine technicien / dispatch / KYC / parrainage.
--   3. Suppression de `Demande.technicianId` et de ses index/contraintes.
--   4. Suppression de `User.referralCode` et de son index unique.
--   5. Suppression des types énumérés devenus orphelins.
--
-- CE QU'ELLE NE TOUCHE PAS (volontairement) :
--   - les tables financières (FinancialTransaction, FundsHold, WithdrawalRequest,
--     TopupIntent, RelioWithdrawal) : elles gardent `technicianId` comme simple
--     trace historique de l'ancien domaine, sans relation vers le technicien ;
--   - reviews, disputes, messages, notifications, diagnostics, devis, alertes IA :
--     adaptés en M6 ;
--   - `User` pour tout le reste, `Zone` et `ServiceCity` (référentiel
--     géographique conservé, référencé par Demande.cityId / zoneId).
--
-- ORDRE : les tables enfants avant les tables mères, pour qu'aucune contrainte
-- de clé étrangère ne bloque la suppression. Les index et contraintes portés
-- par ces tables disparaissent avec elles.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Enum `Role` : CLIENT + ADMIN uniquement
-- ─────────────────────────────────────────────────────────────────────────
-- PostgreSQL ne sait pas retirer une valeur d'un type énuméré : il faut
-- recréer le type. Les comptes encore marqués TECHNICIAN sont ramenés à
-- CLIENT (aucune donnée supprimée : missions, devis et historique financier
-- restent attachés au même compte).
UPDATE "User" SET "role" = 'CLIENT' WHERE "role" = 'TECHNICIAN';

-- La colonne porte un DEFAULT 'CLIENT'::"Role" : il doit être retiré avant
-- le changement de type, sinon PostgreSQL refuse l'ALTER COLUMN.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

CREATE TYPE "Role_new" AS ENUM ('CLIENT', 'ADMIN');

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");

ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'CLIENT';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Tables du domaine technicien / dispatch / KYC / parrainage
-- ─────────────────────────────────────────────────────────────────────────
-- Vagues de dispatch (une ligne = un candidat contacté pour une mission).
DROP TABLE "DispatchWave";

-- Documents KYC du technicien (recto/verso, pièce professionnelle).
DROP TABLE "KycDocument";

-- Journal d'audit des décisions KYC prises par un administrateur.
DROP TABLE "KycReview";

-- Couverture géographique technicien ↔ zone (table de jointure N-N).
DROP TABLE "TechnicianZoneCoverage";

-- Parrainage client (remplacé par le code professionnel B2B en M4).
DROP TABLE "Referral";

-- Profil technicien (supprimé en dernier : les tables ci-dessus y renvoyaient).
DROP TABLE "TechnicianProfile";

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Demande : plus de technicien assigné
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Demande" DROP CONSTRAINT "Demande_technicianId_fkey";
DROP INDEX "Demande_technicianId_idx";
ALTER TABLE "Demande" DROP COLUMN "technicianId";

-- ─────────────────────────────────────────────────────────────────────────
-- 4. User : plus de code de parrainage
-- ─────────────────────────────────────────────────────────────────────────
DROP INDEX "User_referralCode_key";
ALTER TABLE "User" DROP COLUMN "referralCode";

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Types énumérés orphelins
-- ─────────────────────────────────────────────────────────────────────────
DROP TYPE "KycStatus";
DROP TYPE "KycDocumentType";
DROP TYPE "KycDocumentSide";
DROP TYPE "KycIdentityDocumentType";
DROP TYPE "TechnicianActivityType";
DROP TYPE "ReferralStatus";
