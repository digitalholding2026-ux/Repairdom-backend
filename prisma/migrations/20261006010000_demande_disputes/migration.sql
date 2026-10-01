-- Contestation / litige post-intervention (parcours litige).
--
-- NON DESTRUCTIVE : table additive + 2 enums + 2 valeurs d'enum
-- (DemandeEventType, NotificationType), aucune colonne modifiée, aucune
-- ligne existante touchée. Un seul litige par mission (`demandeId`
-- unique = protection anti double-ouverture au niveau base, en plus des
-- gardes applicatives). Historique immuable : ouvertures et décisions
-- conservées, rien supprimé, jamais auto-clôturé.
--
-- Règle financière : aucun règlement tant qu'un litige OPEN/UNDER_REVIEW
-- existe (CONFIRMED refusé dans cet état) ; RESOLVED libère le hold
-- (fonds rendus au client, sans règlement) ; REJECTED rouvre la
-- confirmation normale. Aucun second système financier.

CREATE TYPE "DisputeStatus" AS ENUM (
  'OPEN',
  'UNDER_REVIEW',
  'RESOLVED',
  'REJECTED'
);

CREATE TYPE "DisputeCategory" AS ENUM (
  'QUALITY',
  'INCOMPLETE',
  'PRICING',
  'BEHAVIOR',
  'OTHER'
);

CREATE TABLE "DemandeDispute" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "demandeId" TEXT NOT NULL,
  "openedById" TEXT NOT NULL,
  "category" "DisputeCategory" NOT NULL,
  "description" TEXT NOT NULL,
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DemandeDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DemandeDispute_demandeId_key" ON "DemandeDispute"("demandeId");

CREATE INDEX "DemandeDispute_status_createdAt_idx" ON "DemandeDispute"("status", "createdAt");

ALTER TABLE "DemandeDispute"
  ADD CONSTRAINT "DemandeDispute_demandeId_fkey"
  FOREIGN KEY ("demandeId") REFERENCES "Demande"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DemandeDispute"
  ADD CONSTRAINT "DemandeDispute_openedById_fkey"
  FOREIGN KEY ("openedById") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DemandeDispute"
  ADD CONSTRAINT "DemandeDispute_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Journal de mission : ouverture (client) / clôture (admin), sans
-- changement de statut Demande.
ALTER TYPE "DemandeEventType" ADD VALUE 'DISPUTE_OPENED';
ALTER TYPE "DemandeEventType" ADD VALUE 'DISPUTE_RESOLVED';

-- Notifications : ouverture (ADMIN + technicien assigné), décision
-- (client + technicien assigné). Infra existante réutilisée.
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE_RESOLVED';
