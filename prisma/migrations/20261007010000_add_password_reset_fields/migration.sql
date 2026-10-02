-- Reset password — token à usage unique + invalidation des sessions +
-- journal de rate-limiting en base.
--
-- NON DESTRUCTIVE : 3 colonnes additives et nullables (valeurs par défaut
-- sûres : token NULL, version 0 = sessions existantes conservées), 1 table
-- technique additive sans FK. Aucune donnée existante modifiée.
-- `tokenVersion` invalide tous les JWT émis avant un reset (payload comparé
-- dans `verifyToken`, incrémenté à chaque reset réussi).

ALTER TABLE "User" ADD COLUMN "passwordResetToken" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PasswordResetAttempt" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "ip" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasswordResetAttempt_email_createdAt_idx" ON "PasswordResetAttempt"("email", "createdAt");

CREATE INDEX "PasswordResetAttempt_ip_createdAt_idx" ON "PasswordResetAttempt"("ip", "createdAt");
