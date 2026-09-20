/* Sprint 8.8.2 — Résolution non bloquante texte de ville → ServiceCity.
 *
 * Reproduit EXACTEMENT la normalisation du backfill SQL de la migration
 * `20260929010000_add_zone_and_city_refs` :
 *   - minuscules (lower),
 *   - remplacement des accents « de base » (é/è/ê/ë→e, à/â→a, î/ï→i,
 *     ù/û→u, ô/ö→o, ç→c),
 *   - suppression de TOUS les espaces (regexp '\s' → '').
 *
 * Elle est VOLONTAIREMENT distincte de `normalizeValue` (NFD + espaces
 * unifiés) utilisée par le fallback de matching 8.8.1 : chaque fonction garde
 * son rôle (résolution stricte ici, comparaison tolérante là-bas).
 *
 * Règle D du sprint : correspondance unique ET active → cityId ; aucune
 * correspondance ou ambiguïté → null SANS rejeter l'opération ; le texte
 * original n'est jamais modifié (le retour est un id ou null, jamais un
 * texte réécrit).
 */

export interface CityCandidate {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

/** Normalisation stricte identique au backfill SQL (voir entête). */
export function normalizeGeoToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[éèêë]/g, 'e')
    .replace(/[àâ]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ùû]/g, 'u')
    .replace(/[ôö]/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/\s/g, '');
}

/** Villes ACTIVES du référentiel correspondant au texte (slug ou nom normalisé). */
export function findCityMatches(candidates: CityCandidate[], cityText: string): CityCandidate[] {
  const token = normalizeGeoToken(cityText);
  if (!token) return [];
  return candidates.filter((city) => {
    if (!city.isActive) return false;
    if (city.slug.trim().toLowerCase() === token) return true;
    return normalizeGeoToken(city.name) === token;
  });
}

/**
 * Résout un texte de ville vers un `ServiceCity.id`, ou null.
 * - 1 correspondance active → son id ;
 * - 0 correspondance OU ambiguïté (≥2) → null, sans erreur.
 */
export function resolveCityIdFromCandidates(
  candidates: CityCandidate[],
  cityText: string | null | undefined,
): string | null {
  if (!cityText || !cityText.trim()) return null;
  const matches = findCityMatches(candidates, cityText);
  if (matches.length !== 1) return null;
  return matches[0].id;
}

interface ServiceCityReader {
  serviceCity: {
    findMany(args: unknown): Promise<CityCandidate[]>;
  };
}

/**
 * Résolution non bloquante adossée à la base (villes actives uniquement).
 * Ne rejette jamais : retourne null quand rien ne correspond sans ambiguïté.
 * L'appelant conserve toujours le texte original et décide seul d'écrire
 * `cityId` (ou null).
 */
export async function resolveCityId(
  prisma: ServiceCityReader,
  cityText: string | null | undefined,
): Promise<string | null> {
  if (!cityText || !cityText.trim()) return null;
  const cities = await prisma.serviceCity.findMany({
    where: { isActive: true },
    select: { id: true, name: true, slug: true, isActive: true },
  });
  return resolveCityIdFromCandidates(cities, cityText);
}
