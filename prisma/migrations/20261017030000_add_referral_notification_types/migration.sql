-- Chantier 4B — Parrainage : deux nouvelles valeurs de `NotificationType`.
--
-- `REFERRAL_REWARDED` : le parrain vient d'être crédité (ACTION — il peut
-- consulter ses parrainages et partager davantage). `REFERRAL_WELCOME` : le
-- filleul vient d'être crédité de son bonus de bienvenue (FOLLOW_UP —
-- information, aucune action attendue).
--
-- Fichier séparé pour la même raison que
-- `20261017020000_add_referral_transaction_types` : `ALTER TYPE ... ADD VALUE`
-- est incompatible avec un bloc de transaction sur les PostgreSQL 11 et
-- antérieurs.
ALTER TYPE "NotificationType" ADD VALUE 'REFERRAL_REWARDED';

ALTER TYPE "NotificationType" ADD VALUE 'REFERRAL_WELCOME';
