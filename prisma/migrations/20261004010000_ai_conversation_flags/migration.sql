-- IA-8 — surveillance des conversations (signal uniquement, jamais une
-- sanction : l'IA ne parle jamais dans le chat, ne modifie/supprime rien,
-- ne bloque rien — toute décision reste humaine via la revue admin).
--
-- NON DESTRUCTIVE : table additive + 3 enums + 1 valeur d'enum, aucune
-- colonne modifiée, aucun message existant touché. Un flag par message
-- (messageId unique, idempotence) ; le message reste la source de vérité
-- (aucune copie intégrale stockée). Historique immuable (revue/dismiss
-- conservés, rien supprimé). RGPD/rétention : reportés à IA-10.

CREATE TYPE "AiConversationCategory" AS ENUM (
  'OFF_PLATFORM_PAYMENT',
  'OFF_PLATFORM_CONTACT',
  'CONVERSATION_INCONSISTENCY',
  'PRICE_DISCREPANCY',
  'POTENTIAL_FRAUD',
  'ABUSIVE_OR_PRESSURING_BEHAVIOR',
  'OTHER'
);

CREATE TYPE "AiConversationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "AiConversationFlagStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

CREATE TABLE "AiConversationFlag" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "demandeId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "senderRole" TEXT NOT NULL,
  "category" "AiConversationCategory" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "severity" "AiConversationSeverity" NOT NULL,
  "reason" TEXT,
  "model" TEXT,
  "promptVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "AiConversationFlagStatus" NOT NULL DEFAULT 'OPEN',
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiConversationFlag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiConversationFlag_messageId_key" ON "AiConversationFlag"("messageId");

CREATE INDEX "AiConversationFlag_demandeId_createdAt_idx" ON "AiConversationFlag"("demandeId", "createdAt");

CREATE INDEX "AiConversationFlag_status_createdAt_idx" ON "AiConversationFlag"("status", "createdAt");

ALTER TABLE "AiConversationFlag"
  ADD CONSTRAINT "AiConversationFlag_demandeId_fkey"
  FOREIGN KEY ("demandeId") REFERENCES "Demande"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiConversationFlag"
  ADD CONSTRAINT "AiConversationFlag_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiConversationFlag"
  ADD CONSTRAINT "AiConversationFlag_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiConversationFlag"
  ADD CONSTRAINT "AiConversationFlag_reviewedBy_fkey"
  FOREIGN KEY ("reviewedBy") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Signal admin (infra de notifications existante réutilisée ; aucun
-- deuxième système). Destinataires = ADMIN actifs uniquement.
ALTER TYPE "NotificationType" ADD VALUE 'CONVERSATION_FLAG';
