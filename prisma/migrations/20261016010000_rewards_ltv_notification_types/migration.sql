-- Chantier 4-FONDATIONS-C — Nouvelles valeurs d'enum pour la refonte LTV.
--
-- Rappel du dépôt (migration `20261013010000_add_rewards_system`) :
-- `ALTER TYPE ... ADD VALUE` ne peut pas être exécuté dans une transaction sur
-- les anciennes versions de PostgreSQL — ces ajouts sont donc isolés dans leur
-- PROPRE fichier, sans `BEGIN`/`COMMIT`.
--
-- Les valeurs ajoutées ici :
--   * `NotificationType.REWARD_CREDIT_EARNED` — des crédits de fidélité sont
--     disponibles et attendent une action du client (« ajouter à mon solde ») ;
--   * `NotificationType.REWARD_NATURE_REACHED` — un palier nature vient
--     d'être atteint, il peut être réclamé ;
--   * `FinancialTransactionType.CLIENT_REWARD_CREDIT` — écriture de ledger
--     créé au versement des crédits. DISTINCT de `CLIENT_TOPUP`, qui est une
--     vraie recharge payante : ici aucun encaissement n'a lieu.
--
-- Règle FCFA : aucun de ces types ne transporte de montant formaté. Les
-- montants sont des ENTIERS XAF dans `metadata` (voir
-- `notifications/notification-metadata.ts`).
--
-- Idempotent : relançable sans erreur (`ADD VALUE IF NOT EXISTS`).

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REWARD_CREDIT_EARNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REWARD_NATURE_REACHED';
ALTER TYPE "FinancialTransactionType" ADD VALUE IF NOT EXISTS 'CLIENT_REWARD_CREDIT';