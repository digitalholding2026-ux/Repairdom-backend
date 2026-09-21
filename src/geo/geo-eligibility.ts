/* Éligibilité géographique partagée — MODULE FEUILLE (aucune dépendance de service).
 *
 * Extrait de `technician.service.ts` (correctif boucle circulaire DISPATCH-V1) :
 * `dispatch.service.ts` (vagues 1/2) a besoin de `isGeoEligible`, `isCityMatch`
 * et `normalizeValue` sans importer le `TechnicianService` injectable. Importer
 * le fichier du service technicien depuis le dispatch créait l'arête
 * `dispatch.service.js` → `technician.service.js` → `demandes.service.js` →
 * `dispatch.service.js` (le technicien important lui-même les helpers de
 * demandes), seconde boucle ESM au démarrage.
 *
 * Fonctions COPIÉES À L'IDENTIQUE (aucun changement métier) ; la source de
 * vérité géographique reste ici, `technician.service.ts` les ré-exporte pour
 * compatibilité des imports existants (tests `geo-eligibility.spec.ts`).
 *
 * Volontairement distinct de `normalizeValue` côté `city-reference.ts`
 * (résolution stricte) : comparaison tolérante du fallback 8.8.1, inchangée.
 */

import { isZoneMatch } from './geo-matching.js';

/* Normalisation du fallback 8.8.1 (comparaison tolérante) : minuscules,
 * diacritiques supprimés, ponctuation/tirets neutralisés en espaces,
 * espaces unifiés. La sémantique est inchangée (égalité après
 * normalisation) ; seules des variantes purement typographiques
 * (« Douala, » ≡ « Douala ») cessent d'être discriminées. */
export function normalizeValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’‘′`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/* Sprint DISPATCH-V1 — verrou ville partagé (vague 2 ville entière, zone non
 * exigée) : même verrou ville que `isGeoEligible`, sans duplication. */
export function isCityMatch(
  demandeCityId: string | null,
  demandeCity: string,
  technicianCityId: string | null,
  technicianCity: string,
): boolean {
  if (demandeCityId && technicianCityId) {
    return demandeCityId === technicianCityId;
  }
  return normalizeValue(demandeCity) === normalizeValue(technicianCity);
}

/* Sprint 8.8.2 (règles A + B) — éligibilité géographique complète, centrale
 * et UNIQUE : les trois parcours (recherche, détail, acceptation) l'utilisent
 * telle quelle, sans variante locale.
 * 1. Verrou ville INCHANGÉ (`isCityMatch`, 8.8.1) : une zone commune ne peut
 *    jamais compenser deux `cityId` renseignés et différents.
 * 2. Zone (`isZoneMatch`, règle B) évaluée UNIQUEMENT si la ville matche. */
export interface GeoEligibilityInput {
  demandeCityId: string | null;
  demandeCity: string;
  technicianCityId: string | null;
  technicianCity: string;
  demandeZoneId: string | null;
  technicianActiveZoneIds: readonly string[];
}

export function isGeoEligible(input: GeoEligibilityInput): boolean {
  if (
    !isCityMatch(
      input.demandeCityId,
      input.demandeCity,
      input.technicianCityId,
      input.technicianCity,
    )
  ) {
    return false;
  }
  return isZoneMatch(input.demandeZoneId, input.technicianActiveZoneIds);
}
