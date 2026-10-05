-- Chantier #2D — Centre de notifications.
--
-- UN SEUL ajout : la colonne `metadata` (JSONB) sur `Notification`.
-- Aucune suppression, aucune modification de colonne existante :
--   * `title` / `message` restent des textes génériques, sans montant ;
--   * `readAt`, `createdAt`, `demandeId` sont intacts (marquage lu inchangé).
--
-- Les MONTANTS sont stockés en XAF ENTIER dans `metadata` (jamais
-- « 15 000 FCFA ») : le formatage FCFA est une responsabilité frontend
-- (`formatFCFA`), seule à même de l'adapter à la locale.
--
-- Nullable : les notifications existantes restent valides, et `metadata: null`
-- est traité comme « pas de donnée structurée » par la sérialisation.
--
-- Idempotent : peut être relancé sans erreur si la colonne existe déjà.

ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- `readAt` / `createdAt` sont déjà indexés ; `metadata` n'est pas indexé car
-- il n'est jamais filtré ni trié en base (lecture seule par la sérialisation).
-- Aucun index supplémentaire nécessaire.