-- Dépôt de panne multimédia : description textuelle optionnelle +
-- chemin de stockage des pièces jointes (bucket privé).
--
-- NON DESTRUCTIVE :
--   - `Demande.description` devient nullable : les textes historiques sont
--     intacts ; les nouvelles demandes multimédia (vocal/vidéo/photos)
--     stockent NULL (colonne conservée pour compatibilité/historique) ;
--   - `DemandeMedia.storagePath` est nullable : les métadonnées historiques
--     (metadata-only) restent valides ; les nouveaux uploads y référencent
--     l'objet du bucket privé `relio-demande-medias`.

ALTER TABLE "Demande" ALTER COLUMN "description" DROP NOT NULL;

ALTER TABLE "DemandeMedia" ADD COLUMN "storagePath" TEXT;
