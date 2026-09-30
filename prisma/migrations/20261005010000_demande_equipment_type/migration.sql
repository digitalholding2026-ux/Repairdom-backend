-- IA-4.1 — équipement déclaré par le client pour les demandes « Autre ».
--
-- NON DESTRUCTIVE : colonne scalaire additive et nullable. Aucun champ
-- modifié ou supprimé, aucune donnée historique touchée (NULL pour les
-- demandes existantes et les domaines catalogue connus). Aucun index
-- requis (jamais de recherche plein texte : lecture par demande uniquement).
-- La contrainte « obligatoire si Autre » vit côté backend (service +
-- DTO), pas en base, pour préserver l'historique.

ALTER TABLE "Demande" ADD COLUMN "equipmentType" TEXT;
