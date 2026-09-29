-- IA-3 — note vocale facultative du diagnostic libre du technicien.
--
-- NON DESTRUCTIVE :
--   - `Diagnostic.audioStoragePath` est nullable : les diagnostics
--     existants (texte seul) restent valides, sans backfill ;
--   - aucun index supplémentaire (lecture par `id`, déjà indexé) ;
--   - le chemin pointe le bucket privé `relio-demande-medias`
--     (`diagnostics/{userId}/{uuid}-…`), jamais exposé tel quel
--     (URLs signées éphémères à la lecture).

ALTER TABLE "Diagnostic" ADD COLUMN "audioStoragePath" TEXT;
