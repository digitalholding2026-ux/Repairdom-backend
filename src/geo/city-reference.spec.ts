import { describe, expect, it } from 'vitest';
import {
  findCityMatches,
  normalizeGeoToken,
  resolveCityIdFromCandidates,
  type CityCandidate,
} from './city-reference.js';

/* Sprint 8.8.2 — Règle D (résolution non bloquante texte → ServiceCity).
 * Tests purement unitaires : aucune base de données requise. */

const DOUALA: CityCandidate = { id: 'city-douala', name: 'Douala', slug: 'douala', isActive: true };
const YAOUNDE: CityCandidate = { id: 'city-yaounde', name: 'Yaoundé', slug: 'yaounde', isActive: true };
const INACTIVE: CityCandidate = { id: 'city-old', name: 'Douala', slug: 'douala-old', isActive: false };

describe('normalizeGeoToken', () => {
  it('minuscules + accents + espaces supprimés (aligné backfill SQL)', () => {
    expect(normalizeGeoToken(' Yaoundé ')).toBe('yaounde');
    expect(normalizeGeoToken('Saint Louis')).toBe('saintlouis');
  });
});

describe('findCityMatches', () => {
  it('correspondance exacte sur slug ou nom normalisé', () => {
    expect(findCityMatches([DOUALA, YAOUNDE], 'douala')).toEqual([DOUALA]);
    expect(findCityMatches([DOUALA, YAOUNDE], 'Yaounde')).toEqual([YAOUNDE]);
    expect(findCityMatches([DOUALA, YAOUNDE], '  YAOUNDÉ  ')).toEqual([YAOUNDE]);
  });

  it('ignore les villes inactives', () => {
    expect(findCityMatches([INACTIVE], 'Douala')).toEqual([]);
  });

  it('texte inconnu → aucune correspondance', () => {
    expect(findCityMatches([DOUALA, YAOUNDE], 'Garoua')).toEqual([]);
  });

  it('texte vide → aucune correspondance', () => {
    expect(findCityMatches([DOUALA, YAOUNDE], '   ')).toEqual([]);
  });
});

describe('resolveCityIdFromCandidates', () => {
  it('correspondance unique → id', () => {
    expect(resolveCityIdFromCandidates([DOUALA, YAOUNDE], 'douala')).toBe('city-douala');
  });

  it('aucune correspondance → null (non bloquant)', () => {
    expect(resolveCityIdFromCandidates([DOUALA, YAOUNDE], 'Garoua')).toBeNull();
  });

  it('ambiguïté (≥2) → null, sans erreur', () => {
    const homonymes: CityCandidate[] = [
      { id: 'a', name: 'Douala', slug: 'douala', isActive: true },
      { id: 'b', name: 'DOUALA', slug: 'douala', isActive: true },
    ];
    expect(resolveCityIdFromCandidates(homonymes, 'douala')).toBeNull();
  });

  it('texte vide ou absent → null', () => {
    expect(resolveCityIdFromCandidates([DOUALA], '')).toBeNull();
    expect(resolveCityIdFromCandidates([DOUALA], null)).toBeNull();
    expect(resolveCityIdFromCandidates([DOUALA], undefined)).toBeNull();
  });
});
