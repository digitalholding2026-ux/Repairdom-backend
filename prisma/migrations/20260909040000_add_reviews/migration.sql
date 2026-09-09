-- SPRINT 6 — Réputation bilatérale RepairDom (client ↔ technicien).
-- Rédigée manuellement pour correspondre au DDL généré par Prisma 7
-- (migrate deploy sur PostgreSQL Railway), non destructive.
--
-- Nouveau modèle Review : une évaluation postée par un utilisateur
-- (author) vers l'autre partie (target) d'une Demande CONFIRMED.
-- - Rating entier 1..5 (contraint par le backend + CHECK en base).
-- - Commentaire facultatif, limité à 1000 caractères (backend).
-- - @@unique([demandeId, authorId]) : un auteur ne peut évaluer
--   qu'une seule fois une même demande (niveau base de données).
-- Relations explicites author/target vers User (sinon ambiguës).

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "demandeId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Review_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5)
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_demandeId_authorId_key" ON "Review"("demandeId", "authorId");
CREATE INDEX "Review_targetId_idx" ON "Review"("targetId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_demandeId_fkey" FOREIGN KEY ("demandeId") REFERENCES "Demande"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;