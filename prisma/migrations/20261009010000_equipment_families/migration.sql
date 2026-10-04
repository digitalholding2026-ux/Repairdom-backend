-- Familles d'équipements du parcours « Autre appareil » (indices structurés).
--
-- NON DESTRUCTIVE : nouvelle table + colonne scalaire additive et nullable
-- sur Demande. Aucun champ modifié ou supprimé, aucune donnée historique
-- touchée (NULL pour les demandes existantes). `equipmentType` (texte libre)
-- est conservé pour l'historique : les nouvelles demandes « Autre » portent
-- un code de famille (`equipmentFamily`), jamais du texte libre.
-- La contrainte « famille active obligatoire si Autre sans domaine » vit
-- côté backend (service + DTO), pas en base, pour préserver l'historique.

-- CreateTable EquipmentFamily
CREATE TABLE "EquipmentFamily" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT,
    "category" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentFamily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentFamily_code_key" ON "EquipmentFamily"("code");
CREATE INDEX "EquipmentFamily_isActive_idx" ON "EquipmentFamily"("isActive");

-- AlterTable Demande : indice structuré (code de famille, pas de FK pour
-- préserver l'historique même si la famille est désactivée un jour).
ALTER TABLE "Demande" ADD COLUMN "equipmentFamily" TEXT;
CREATE INDEX "Demande_equipmentFamily_idx" ON "Demande"("equipmentFamily");

-- Seed initial : familles rattachées aux 7 catégories métier de dispatch
-- (ce que Relio sait réellement dispatcher). Courte, administrable depuis
-- le backoffice ; « UNKNOWN » (« Je ne sais pas ») mappe vers `autre` et
-- reste identifiable (jamais un fourre-tout silencieux).
INSERT INTO "EquipmentFamily" ("code", "label", "icon", "category", "sortOrder", "updatedAt") VALUES
  ('GAME_CONSOLE', 'Console / jeu vidéo', '🎮', 'electromenager', 10, CURRENT_TIMESTAMP),
  ('TV_ECRAN', 'Télévision / écran', '📺', 'electromenager', 20, CURRENT_TIMESTAMP),
  ('AUDIO_SON', 'Audio / sono', '🔊', 'electromenager', 30, CURRENT_TIMESTAMP),
  ('IMPRIMANTE', 'Imprimante / scanner', '🖨️', 'informatique', 40, CURRENT_TIMESTAMP),
  ('ENERGIE', 'Groupe électrogène / onduleur / solaire', '🔌', 'electricite', 50, CURRENT_TIMESTAMP),
  ('POMPE_EAU', 'Pompe à eau / forage', '💧', 'plomberie', 60, CURRENT_TIMESTAMP),
  ('VENTILATION', 'Ventilateur / brasseur d’air', '🌀', 'climatisation', 70, CURRENT_TIMESTAMP),
  ('COFFRE', 'Coffre-fort / serrure spéciale', '🔐', 'serrurerie', 80, CURRENT_TIMESTAMP),
  ('UNKNOWN', 'Je ne sais pas', '❓', 'autre', 100, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
