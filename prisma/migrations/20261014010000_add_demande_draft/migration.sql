-- Chantier D1 — brouillon de demande pour visiteur NON authentifié.
--
-- Décision D1 : aucune `Demande` n'est créée sans client. Le visiteur décrit
-- sa panne dans cette table, derrière un `token` UUID v4 (lien magique). La
-- vraie `Demande` (statut SUBMITTED) naît au `convert`, une fois le compte
-- créé.
--
-- `convertedToDemandeId` est volontairement une colonne SANS relation Prisma :
-- la conversion est un point dans le temps, et une contrainte d'intégrité
-- vers `Demande` ferait échouer la purge par expiration si une Demande était
-- supprimée en cascade. L'unicité reste garantie par l'index unique.

CREATE TABLE IF NOT EXISTS "DemandeDraft" (
    "id"                    TEXT         NOT NULL DEFAULT gen_random_uuid(),
    "token"                 TEXT         NOT NULL,
    "categoryId"            TEXT         NOT NULL,
    "domainId"              TEXT,
    "brandId"               TEXT,
    "equipmentFamily"       TEXT,
    "description"           TEXT         NOT NULL,
    "city"                  TEXT         NOT NULL,
    "neighborhood"          TEXT,
    "address"               TEXT,
    "landmark"              TEXT,
    "contactPhone"          TEXT,
    "latitude"              DOUBLE PRECISION,
    "longitude"             DOUBLE PRECISION,
    "requestedMode"         TEXT         NOT NULL DEFAULT 'ASAP',
    "requestedAt"           TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    "expiresAt"             TIMESTAMP(3) NOT NULL,
    "convertedToDemandeId"  TEXT,
    "convertedAt"           TIMESTAMP(3),
    "convertedByUserId"     TEXT,

    CONSTRAINT "DemandeDraft_pkey" PRIMARY KEY ("id")
);

-- `token` est le secret du lien magique : DOIT être unique et indexé
-- (toutes les routes publiques font `findUnique({ where: { token } })`).
CREATE UNIQUE INDEX IF NOT EXISTS "DemandeDraft_token_key" ON "DemandeDraft"("token");

-- Un brouillon ne peut convertir qu'UNE fois.
CREATE UNIQUE INDEX IF NOT EXISTS "DemandeDraft_convertedToDemandeId_key"
    ON "DemandeDraft"("convertedToDemandeId");

-- Purge paresseuse : la sélection filtre systématiquement sur `expiresAt`.
CREATE INDEX IF NOT EXISTS "DemandeDraft_expiresAt_idx" ON "DemandeDraft"("expiresAt");

CREATE INDEX IF NOT EXISTS "DemandeDraft_convertedAt_idx" ON "DemandeDraft"("convertedAt");