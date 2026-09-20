/* Sprint 8.8.2 — Règle B : matching de zone avec transition.
 *
 * Fonction centrale et UNIQUE du matching par zone. Utilisée telle quelle par
 * les trois parcours technicien (recherche, détail, acceptation) : aucune
 * variante locale n'est autorisée.
 *
 * Règles appliquées (après le verrou ville `isCityMatch`, jamais avant) :
 * - demande sans `zoneId` → pas d'exclusion sur la base des zones ;
 * - technicien sans couverture ACTIVE → pas d'exclusion (transition : les
 *   techniciens existants n'ont aucune couverture déclarée) ;
 * - demande zonée + technicien avec ≥1 couverture active → il doit couvrir
 *   exactement cette zone, sinon exclusion ;
 * - seules des couvertures actives alimentent `technicianActiveZoneIds`
 *   (les zones inactives ne rendent jamais éligible — règle F).
 *
 * Cette fonction ne connaît pas les villes : l'appelant DOIT vérifier
 * `isCityMatch() === true` avant (règle A). Elle ne peut donc jamais autoriser
 * un technicien refusé par le matching de ville.
 */

/**
 * Prédicat de zone seul (ville déjà validée par l'appelant).
 * @param demandeZoneId zone structurée de la demande, ou null si non zonée.
 * @param technicianActiveZoneIds identifiants des zones ACTIVES couvertes.
 */
export function isZoneMatch(
  demandeZoneId: string | null,
  technicianActiveZoneIds: readonly string[],
): boolean {
  if (!demandeZoneId) return true;
  if (technicianActiveZoneIds.length === 0) return true;
  return technicianActiveZoneIds.includes(demandeZoneId);
}

/* Sprint 8.8.2 (GEO-04) — filtrage défensif des couvertures, sans suppression
 * destructive : un changement de ville du technicien neutralise
 * immédiatement les anciennes couvertures (autre ville) pour le matching,
 * les lignes historiques restant conservées en base.
 *
 * Seule une couverture ACTIVE dont la zone appartient à la ville de
 * référence COURANTE du profil est retenue. Sans `cityId` (profil non
 * rattaché), rien n'est retenu — `isZoneMatch` applique alors le régime de
 * transition (aucune exclusion sur la base des zones).
 */
export interface CoverageZoneRow {
  zoneId: string;
  zone: { isActive: boolean; cityId: string };
}

export function filterActiveCoverageZoneIdsForCity(
  coverages: readonly CoverageZoneRow[],
  technicianCityId: string | null,
): string[] {
  if (!technicianCityId) return [];
  return coverages
    .filter((coverage) => coverage.zone.isActive && coverage.zone.cityId === technicianCityId)
    .map((coverage) => coverage.zoneId);
}
