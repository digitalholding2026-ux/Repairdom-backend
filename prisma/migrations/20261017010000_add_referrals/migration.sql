-- Chantier 4B — PARRAINAGE CLIENT : table `Referral`, enum et code personnel.
--
-- Migration STRICTEMENT additive : aucune donnée existante n'est touchée, la
-- table est créée VIDE et aucun `User.referralCode` n'est pré-rempli. Les
-- clients qui n'ont jamais parrainé gardent `referralCode = NULL` — un code
-- n'est généré qu'à la première demande, pas à l'inscription. C'est un choix
-- assumé : pré-remplir million de lignes ferait porter un index unique pour
-- rien, et le code n'a de valeur que s'il est demandé.
--
-- L'ordre des opérations est important : la colonne `User.referralCode` porte
-- un index unique, et `Referral.referredId` est unique : sans ces index, rien
-- n'empêcherait deux parrainages concurrents pour le même filleul.

-- 1) Enum des états d'un parrainage.
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REGISTERED', 'REWARDED', 'EXPIRED');

-- 2) Table des parrainages.
--
-- `referredId` est UNIQUE : un client ne peut avoir qu'un parrain. Son
-- `ON DELETE` est `SetNull` — si le compte du filleul est supprimé, la ligne
-- survit : la récompense déjà versée au parrain ne doit pas disparaître de
-- l'historique avec le compte du filleul. C'est aussi pourquoi `status` et
-- `rewardedAt` sont sur CETTE table et non dérivables d'un compte.
--
-- `referrerId` est en `Cascade` : les parrainages d'un compte supprimé
-- n'ont plus de sens.
--
-- `id` est un UUID applicatif comme sur le reste du schéma : les clés
-- étrangères y sont référencées.
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT,
    "code" TEXT NOT NULL,
    "referredEmail" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- 3) Index uniques : un filleul, un seul parrain ; un code, un seul porteur.
CREATE UNIQUE INDEX "Referral_referredId_key" ON "Referral"("referredId");
CREATE UNIQUE INDEX "Referral_code_key" ON "Referral"("code");

-- 4) Index de lecture : la page « mes filleuls » filtre par parrain et trie par
-- création ; l'administration desRewards filtre par statut.
CREATE INDEX "Referral_referrerId_idx" ON "Referral"("referrerId");
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- 5) Code personnel du client, généré à la première demande.
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- 6) Clés étrangères.
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;