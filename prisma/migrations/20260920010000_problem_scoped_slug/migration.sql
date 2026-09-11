-- SPRINT 8.6.5 — Unicité du slug Problem scopée par (domainId, brandId, modelId).
--
-- La contrainte unique historique (domainId, slug) interdisait de créer deux
-- problèmes de même libellé (« Écran cassé ») sur deux modèles différents
-- (ex. Tecno Camon 30 et Tecno Spark 20), alors que les tarifs sont
-- configurables par modèle.
--
-- Remplacement par un index unique FONCTIONNEL :
--   UNIQUE (domainId, COALESCE(brandId,''), COALESCE(modelId,''), slug)
-- Règles garanties :
--   - même domaine + même marque + même modèle + même slug → interdit ;
--   - même libellé sur deux modèles différents → autorisé ;
--   - problème générique (brandId/modelId NULL → '') → unicité conservée dans
--     son scope générique (deux génériques de même slug dans un domaine restent
--     impossibles).
--
-- Rédigée manuellement (les index fonctionnels ne sont pas exprimables dans le
-- schéma Prisma). Non destructive : aucun problème existant n'est modifié ni
-- supprimé ; l'ancienne contrainte est simplement remplacée par l'index
-- fonctionnel équivalent pour les enregistrements déjà en base.

DROP INDEX IF EXISTS "Problem_domainId_slug_key";

CREATE UNIQUE INDEX "Problem_domain_brand_model_slug_key"
  ON "Problem"(
    "domainId",
    COALESCE("brandId", ''),
    COALESCE("modelId", ''),
    "slug"
  );