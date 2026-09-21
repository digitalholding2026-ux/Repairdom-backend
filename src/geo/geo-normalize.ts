/* Matching géographique intelligent — normalisation canonique centralisée.
 *
 * Fonction UNIQUE de normalisation pour la résolution (ville/zone) : elle
 * étend `normalizeGeoToken` (compat backfill SQL : minuscules + accents de
 * base + espaces supprimés) sans la contredire :
 *  - minuscules (lower) ;
 *  - suppression de TOUS les diacritiques (NFD, superset des accents de base) ;
 *  - variantes d'apostrophes unifiées ;
 *  - ponctuation / tirets / underscores → espace (séparateurs non significatifs) ;
 *  - espaces multiples → espace unique, trim.
 *
 * Règle anti-faux-positif : la normalisation ne rapproche que des chaînes
 * identiques une fois les variantes typographiques levées (« Douala, » ≡
 * « Douala ») ; elle ne rend JAMAIS égales deux localisations différentes
 * (« Douala-Littoral » ≠ « Douala », « Dschang » ≠ « Douala »).
 * Toute correspondance finale exige en outre une entrée UNIQUE et ACTIVE du
 * référentiel (voir `city-reference.ts`).
 */

/** Correspondances explicites au-delà de NFD (ligatures / lettres barrées). */
const EXTRA_FOLDS: Array<[RegExp, string]> = [
  [/[œ]/g, 'oe'],
  [/[æ]/g, 'ae'],
  [/ß/g, 'ss'],
  [/[ø]/g, 'o'],
  [/[ł]/g, 'l'],
  [/[đ]/g, 'd'],
  [/[þ]/g, 'th'],
  [/[ŋ]/g, 'n'],
];

/**
 * Forme canonique comparable (espaces unifiés, ponctuation neutralisée).
 * Exemples : " DOUALÀ " → "douala", "Douala  " → "douala",
 * "Douala-Littoral" → "douala littoral", "l'Adamaoua" → "l'adamaoua".
 */
export function normalizeGeoText(value: string): string {
  const stripped = value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  // Minuscules AVANT les replis explicites (e.g. « Œ » → « œ » → « oe »).
  let out = stripped.toLowerCase();
  for (const [pattern, replacement] of EXTRA_FOLDS) {
    out = out.replace(pattern, replacement);
  }
  return out
    .replace(/[’‘′`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jeton canonique sans espace (comparaison style slug/nom du référentiel).
 * Compatible avec `normalizeGeoToken` : tout ce que l'ancien jeton égalisait
 * reste égal ici (accents de base + casse + espaces), avec en plus la
 * ponctuation neutralisée (« saint-louis » ≡ « saint louis »).
 */
export function canonicalGeoToken(value: string): string {
  return normalizeGeoText(value).replace(/ /g, '');
}

/**
 * Tête avant la première virgule (« Douala, Littoral » → « Douala »).
 * Utilisée UNIQUEMENT comme tentative de résolution : la tête doit à son
 * tour correspondre exactement à UNE entrée active du référentiel, sinon
 * la localisation reste non résolue (aucune invention).
 */
export function geoHead(value: string): string {
  return value.split(',')[0].trim();
}

/** Distance de Levenshtein avec plafond (2 suffisent aux gates ci-dessous). */
export function levenshteinCapped(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let current0 = i;
    let rowMin = current0;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, current0 + 1, prev[j - 1] + cost);
      prev[j - 1] = current0;
      current0 = next;
      if (next < rowMin) rowMin = next;
    }
    prev[b.length] = current0;
    if (rowMin > cap) return cap + 1;
  }
  return prev[b.length];
}
