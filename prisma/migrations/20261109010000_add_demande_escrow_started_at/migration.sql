-- M2 — Horodatage de démarrage de l'escrow sur Demande.
--
-- ADDITIVE : colonne nullable, aucune donnée historique touchée.
-- `escrowStartedAt` est défini au paiement Escrow et sert au calcul du délai
-- de 48h avant remboursement automatique (EscrowCronService).
-- Idempotent : IF NOT EXISTS permet le re-déploiement sans erreur.

ALTER TABLE "Demande" ADD COLUMN IF NOT EXISTS "escrowStartedAt" TIMESTAMP(3);
