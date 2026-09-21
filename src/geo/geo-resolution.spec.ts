import { describe, expect, it } from 'vitest';
import {
  findZoneMatches,
  resolveGeoFromText,
  type CityCandidate,
  type ZoneCandidate,
} from './city-reference.js';

/* Matching intelligent — Phase 3 : résolution canonique ordonnée.
 * Référentiel fictif minimal et déterministe (aucune base de données). */

const CITIES: CityCandidate[] = [
  { id: 'c-douala', name: 'Douala', slug: 'douala', isActive: true },
  { id: 'c-yaounde', name: 'Yaoundé', slug: 'yaounde', isActive: true },
  { id: 'c-dschang', name: 'Dschang', slug: 'dschang', isActive: true },
  { id: 'c-old', name: 'Vieille Ville', slug: 'vieille-ville', isActive: false },
];

const ZONES: ZoneCandidate[] = [
  { id: 'z-boko', name: 'Boko', slug: 'boko', cityId: 'c-douala', isActive: true },
  { id: 'z-akwa', name: 'Akwa', slug: 'akwa', cityId: 'c-douala', isActive: true },
  { id: 'z-bonamoussadi', name: 'Bonamoussadi', slug: 'bonamoussadi', cityId: 'c-douala', isActive: true },
  { id: 'z-fermee', name: 'Zone Fermée', slug: 'zone-fermee', cityId: 'c-douala', isActive: false },
];

describe('resolveGeoFromText — niveau 1/2 : ville exacte', () => {
  it('nom exact toutes casses/espaces/accents', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'douala')).toEqual({ cityId: 'c-douala', zoneId: null });
    expect(resolveGeoFromText(CITIES, ZONES, '  YAOUNDÉ ')).toEqual({ cityId: 'c-yaounde', zoneId: null });
  });

  it('tirets neutralisés : Saint-Louis ≡ Saint Louis (aucune invention)', () => {
    const cities: CityCandidate[] = [
      ...CITIES,
      { id: 'c-saint-louis', name: 'Saint Louis', slug: 'saint-louis', isActive: true },
    ];
    expect(resolveGeoFromText(cities, ZONES, 'Saint-Louis')).toEqual({
      cityId: 'c-saint-louis',
      zoneId: null,
    });
  });

  it('ville + région : tête avant virgule (cas 7)', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Douala, Littoral')).toEqual({
      cityId: 'c-douala',
      zoneId: null,
    });
  });

  it('suffixe région au tiret NON résolu (frontière anti-faux-positif documentée)', () => {
    // « Douala-Littoral » n'est ni une ville exacte, ni une zone exacte :
    // cityId reste null, le texte est conservé pour le fallback historique.
    expect(resolveGeoFromText(CITIES, ZONES, 'Douala-Littoral')).toEqual({
      cityId: null,
      zoneId: null,
    });
  });
});

describe('resolveGeoFromText — niveau 3 : nom de zone seul', () => {
  it('zone exacte → ville + zone dérivées', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Boko')).toEqual({ cityId: 'c-douala', zoneId: 'z-boko' });
    expect(resolveGeoFromText(CITIES, ZONES, 'boko, douala')).toEqual({
      cityId: 'c-douala',
      zoneId: 'z-boko',
    });
  });

  it('zone inactive jamais résolue (cas 13/17)', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Zone Fermée')).toEqual({ cityId: null, zoneId: null });
  });

  it('zone inconnue → null (cas 13)', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Quartier Inexistant')).toEqual({
      cityId: null,
      zoneId: null,
    });
  });
});

describe('resolveGeoFromText — niveau 4 : typo sûre (cas 14/15)', () => {
  it('faute mineure unique et sans concurrent : Doula → Douala', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Doula')).toEqual({ cityId: 'c-douala', zoneId: null });
  });

  it('aucun rapprochement dangereux : Dschang ne devient jamais Douala', () => {
    // « Dschang » est exacte ici ; la garde anti-faux-positif se vérifie
    // avec un texte équidistant ou lointain : aucune résolution.
    expect(resolveGeoFromText(CITIES, ZONES, 'Dschang')).toEqual({
      cityId: 'c-dschang',
      zoneId: null,
    });
    expect(resolveGeoFromText(CITIES, ZONES, 'Dscha')).toEqual({ cityId: null, zoneId: null });
  });

  it('concurrent proche → refus (pas de devinette)', () => {
    const cities: CityCandidate[] = [
      { id: 'c-douala', name: 'Douala', slug: 'douala', isActive: true },
      { id: 'c-douola', name: 'Douola', slug: 'douola', isActive: true },
    ];
    // « Doula » est à distance 1 des DEUX : ambiguïté → null.
    expect(resolveGeoFromText(cities, ZONES, 'Doula')).toEqual({ cityId: null, zoneId: null });
  });

  it('ville inconnue : jamais de cityId inventé (cas 5/12)', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Garoua')).toEqual({ cityId: null, zoneId: null });
    expect(resolveGeoFromText(CITIES, ZONES, '')).toEqual({ cityId: null, zoneId: null });
    expect(resolveGeoFromText(CITIES, ZONES, null)).toEqual({ cityId: null, zoneId: null });
  });

  it('ville inactive jamais résolue', () => {
    expect(resolveGeoFromText(CITIES, ZONES, 'Vieille Ville')).toEqual({
      cityId: null,
      zoneId: null,
    });
  });

  it('ambiguïté exacte : deux villes homonymes → null', () => {
    const cities: CityCandidate[] = [
      { id: 'c-a', name: 'Douala', slug: 'douala', isActive: true },
      { id: 'c-b', name: 'DOUALA', slug: 'douala', isActive: true },
    ];
    expect(resolveGeoFromText(cities, ZONES, 'douala')).toEqual({ cityId: null, zoneId: null });
  });
});

describe('findZoneMatches', () => {
  it('slug ou nom, actifs uniquement', () => {
    expect(findZoneMatches(ZONES, 'akwa').map((z) => z.id)).toEqual(['z-akwa']);
    expect(findZoneMatches(ZONES, 'BONAMOUSSADI').map((z) => z.id)).toEqual(['z-bonamoussadi']);
    expect(findZoneMatches(ZONES, 'Zone Fermée')).toEqual([]);
  });
});
