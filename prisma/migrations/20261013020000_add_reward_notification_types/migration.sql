-- Chantier #4A — Programme de récompenses : deux nouvelles valeurs de
-- `NotificationType`.
--
-- `REWARD_TIER_REACHED` : un palier vient d'être franchi (SUIVI côté client).
-- `REWARD_MISSION_NOT_COUNTED` : une mission n'a pas été comptabilisée à la
-- suite d'une décision administrative sur un signalement anti-fraude (ACTION).
--
-- Fichier séparé de `20261013010000_add_rewards_system` car
-- `ALTER TYPE ... ADD VALUE` est incompatible avec un bloc de transaction sur
-- les PostgreSQL 11 et antérieurs.
ALTER TYPE "NotificationType" ADD VALUE 'REWARD_TIER_REACHED';

ALTER TYPE "NotificationType" ADD VALUE 'REWARD_MISSION_NOT_COUNTED';
