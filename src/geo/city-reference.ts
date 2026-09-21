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

import { canonicalGeoToken, geoHead, levenshteinCapped } from './geo-normalize.js';

export interface CityCandidate {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

/** Candidat zone pour la dérivation (nom de zone seul → ville + zone). */
export interface ZoneCandidate {
  id: string;
  name: string;
  slug: string;
  cityId: string;
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

/** Villes ACTIVES du référentiel correspondant au texte (slug ou nom normalisé).
 * Comparaison canonique (`canonicalGeoToken`) : sur-ensemble strict de
 * l'ancienne égalité — tout ce qui matchait avant matche toujours
 * (« Douala », « Yaoundé »), avec en plus la ponctuation neutralisée
 * (« Saint-Louis » ≡ « Saint Louis »). Exige toujours unicité + activité
 * côté appelant (`resolveCityIdFromCandidates`). */
export function findCityMatches(candidates: CityCandidate[], cityText: string): CityCandidate[] {
  const token = canonicalGeoToken(cityText);
  if (!token) return [];
  return candidates.filter((city) => {
    if (!city.isActive) return false;
    if (canonicalGeoToken(city.slug) === token) return true;
    return canonicalGeoToken(city.name) === token;
  });
}

/** Zones ACTIVES correspondant au texte (slug ou nom canonique). */
export function findZoneMatches(candidates: ZoneCandidate[], zoneText: string): ZoneCandidate[] {
  const token = canonicalGeoToken(zoneText);
  if (!token) return [];
  return candidates.filter((zone) => {
    if (!zone.isActive) return false;
    if (canonicalGeoToken(zone.slug) === token) return true;
    return canonicalGeoToken(zone.name) === token;
  });
}

/* Tolérance aux fautes ULTRA-conservatrice (Phase 5 : uniquement « si
 * suffisamment sûr », jamais comme unique mécanisme) :
 * - distance de Levenshtein ≤ 1 sur le jeton canonique ;
 * - jetons d'au moins 5 caractères des deux côtés ;
 * - AUCUN autre candidat actif à distance ≤ 2 (pas de concurrent proche) ;
 * - sinon : non résolu (null), jamais de devinette.
 * Exemple autorisé : « Doula » → Douala (si unique).
 * Exemple refusé : « Dschang » (aucun voisin à distance ≤ 1). */
const TYPO_MAX_DISTANCE = 1;
const TYPO_MIN_TOKEN_LENGTH = 5;
const TYPO_RUNNER_UP_DISTANCE = 2;

function closestUniqueToken(
  candidates: Array<{ key: string; token: string }>,
  inputToken: string,
): string | null {
  if (inputToken.length < TYPO_MIN_TOKEN_LENGTH) return null;
  let bestKey: string | null = null;
  let bestDistance = TYPO_RUNNER_UP_DISTANCE + 1;
  let runnerUp = TYPO_RUNNER_UP_DISTANCE + 1;
  for (const candidate of candidates) {
    if (candidate.token.length < TYPO_MIN_TOKEN_LENGTH) continue;
    const distance = levenshteinCapped(inputToken, candidate.token, TYPO_RUNNER_UP_DISTANCE);
    if (distance < bestDistance) {
      runnerUp = bestDistance;
      bestDistance = distance;
      bestKey = candidate.key;
    } else if (candidate.key !== bestKey && distance < runnerUp) {
      // Les doublons slug/nom d'UNE même entrée ne comptent jamais comme
      // concurrent : seul un AUTRE candidat peut invalider le rapprochement.
      runnerUp = distance;
    }
  }
  if (bestKey === null || bestDistance > TYPO_MAX_DISTANCE) return null;
  if (runnerUp <= TYPO_RUNNER_UP_DISTANCE) return null;
  return bestKey;
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

export interface ResolvedGeo {
  cityId: string | null;
  zoneId: string | null;
}

/* Résolution canonique ordonnée d'un texte libre (création de demande).
 * Ordre : 1. ville exacte (texte entier) → 2. ville exacte (tête avant
 * virgule, ex. « Douala, Littoral ») → 3. zone exacte (texte puis tête :
 * nom de zone seul, ex. « Boko ») → 4. ville typo sûre → 5. zone typo sûre.
 * Chaque niveau exige unicité + activité ; ambiguïté ou échec → niveau
 * suivant, puis { null, null } (jamais d'invention, règle Cas E). */
export function resolveGeoFromText(
  cities: CityCandidate[],
  zones: ZoneCandidate[],
  text: string | null | undefined,
): ResolvedGeo {
  const none: ResolvedGeo = { cityId: null, zoneId: null };
  if (!text || !text.trim()) return none;

  const cityMatches = findCityMatches(cities, text);
  if (cityMatches.length === 1) return { cityId: cityMatches[0].id, zoneId: null };
  if (cityMatches.length > 1) return none;

  const head = geoHead(text);
  if (head && canonicalGeoToken(head) !== canonicalGeoToken(text)) {
    const headMatches = findCityMatches(cities, head);
    if (headMatches.length === 1) return { cityId: headMatches[0].id, zoneId: null };
    if (headMatches.length > 1) return none;
  }

  const zoneMatches = findZoneMatches(zones, text);
  const headZoneMatches =
    head && canonicalGeoToken(head) !== canonicalGeoToken(text)
      ? findZoneMatches(zones, head)
      : [];
  const allZoneMatches = [...zoneMatches, ...headZoneMatches.filter((z) => !zoneMatches.some((m) => m.id === z.id))];
  if (allZoneMatches.length === 1) {
    return { cityId: allZoneMatches[0].cityId, zoneId: allZoneMatches[0].id };
  }
  if (allZoneMatches.length > 1) return none;

  const inputToken = canonicalGeoToken(text);
  const cityKeys = cities
    .filter((city) => city.isActive)
    .flatMap((city) => [
      { key: `city:${city.id}`, token: canonicalGeoToken(city.slug) },
      { key: `city:${city.id}`, token: canonicalGeoToken(city.name) },
    ]);
  const typoCity = closestUniqueToken(cityKeys, inputToken);
  if (typoCity) return { cityId: typoCity.slice('city:'.length), zoneId: null };

  const zoneKeys = zones
    .filter((zone) => zone.isActive)
    .flatMap((zone) => [
      { key: `zone:${zone.id}`, token: canonicalGeoToken(zone.slug) },
      { key: `zone:${zone.id}`, token: canonicalGeoToken(zone.name) },
    ]);
  const typoZone = closestUniqueToken(zoneKeys, inputToken);
  if (typoZone) {
    const zone = zones.find((z) => z.id === typoZone.slice('zone:'.length));
    if (zone) return { cityId: zone.cityId, zoneId: zone.id };
  }
  return none;
}
