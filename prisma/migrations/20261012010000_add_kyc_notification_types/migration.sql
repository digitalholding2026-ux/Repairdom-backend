-- Chantier #5A — Décision KYC notifiée au technicien.
--
-- UN SEUL ajout : deux valeurs dans l'enum `NotificationType`.
-- Aucune suppression, aucune modification de colonne ou d'index :
--   * `Notification.demandeId` reste `NULL` (une décision KYC ne concerne
--     aucune mission) → la notification est affichée À PLAT dans le centre,
--     jamais regroupée par mission ;
--   * `readAt` / `createdAt` / `metadata` sont intacts (marquage lu inchangé,
--     contrat `metadata` du chantier #2D respecté).
--
-- `KYC_REJECTED` est une ACTION (le technicien doit corriger et renvoyer son
-- dossier), `KYC_VERIFIED` un SUIVI (déblocage de l'acceptation de missions).
--
-- AUCUN MONTANT : ces notifications ne transportent que du texte et un motif
-- de rejet libre. La règle FCFA est donc hors sujet ici.
--
-- Idempotent : peut être relancé sans erreur si les valeurs existent déjà
-- (`ADD VALUE IF NOT EXISTS`, PostgreSQL 12+).

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'KYC_REJECTED';
