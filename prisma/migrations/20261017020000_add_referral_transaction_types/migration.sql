-- Chantier 4B — Parrainage : deux nouvelles valeurs de
-- `FinancialTransactionType`.
--
-- `CLIENT_REFERRAL_REWARD` (CREDIT) : le PARRAIN est crédité de la récompense
-- due par le filleul. `CLIENT_REFERRAL_RECEIVED` (CREDIT) : le FILLEUL est
-- crédité de son bonus de bienvenue.
--
-- Deux écritures distinctes, et non une seule à double sens : le ledger doit
-- pouvoir répondre « qui a été crédité, et pour quoi » sans jamais élargir
-- l'interprétation d'une ligne. Les deux sont également distinctes de
-- `CLIENT_REWARD_CREDIT` (fidélité) et de `CLIENT_TOPUP` (vraie recharge
-- payante) : ici, aucun encaissement n'a lieu — c'est un avantage acquis par
-- un tiers.
--
-- Fichier séparé de `20261017010000_add_referrals` car `ALTER TYPE ... ADD
-- VALUE` est incompatible avec un bloc de transaction sur les PostgreSQL 11 et
-- antérieurs ; Railway peut être mis à jour, on ne veut pas en dépendre.
ALTER TYPE "FinancialTransactionType" ADD VALUE 'CLIENT_REFERRAL_REWARD';

ALTER TYPE "FinancialTransactionType" ADD VALUE 'CLIENT_REFERRAL_RECEIVED';
