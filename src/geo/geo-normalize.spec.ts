import { describe, expect, it } from 'vitest';
import {
  canonicalGeoToken,
  geoHead,
  levenshteinCapped,
  normalizeGeoText,
} from './geo-normalize.js';

/* Matching intelligent — Phase 2 : normalisation canonique.
 * Purement unitaire, sans base de données. */

describe('normalizeGeoText', () => {
  it('lowercase + trim + espaces multiples (cas 2, 4, 5)', () => {
    expect(normalizeGeoText('Douala')).toBe('douala');
    expect(normalizeGeoText('DOUALA')).toBe('douala');
    expect(normalizeGeoText('  Douala  ')).toBe('douala');
    expect(normalizeGeoText('Douala   Nord')).toBe('douala nord');
  });

  it('accents et diacritiques (cas 3)', () => {
    expect(normalizeGeoText('DOUALÀ')).toBe('douala');
    expect(normalizeGeoText('Yaoundé')).toBe('yaounde');
    expect(normalizeGeoText('Œuf')).toBe('oeuf');
  });

  it('tirets et ponctuation neutralisés, sans fusion abusive (cas 6)', () => {
    expect(normalizeGeoText('Douala-Littoral')).toBe('douala littoral');
    expect(normalizeGeoText('Saint_Louis')).toBe('saint louis');
    expect(normalizeGeoText('Douala,')).toBe('douala');
    expect(normalizeGeoText("l'Adamaoua")).toBe("l'adamaoua");
  });
});

describe('canonicalGeoToken', () => {
  it('forme slug comparable', () => {
    expect(canonicalGeoToken(' Saint-Louis ')).toBe('saintlouis');
    expect(canonicalGeoToken('Saint Louis')).toBe('saintlouis');
    expect(canonicalGeoToken('Douala, Littoral')).toBe('doualalittoral');
  });
});

describe('geoHead', () => {
  it('tête avant virgule (cas 7 : ville + région)', () => {
    expect(geoHead('Douala, Littoral')).toBe('Douala');
    expect(geoHead('douala littoral')).toBe('douala littoral');
    expect(geoHead('Douala')).toBe('Douala');
  });
});

describe('levenshteinCapped', () => {
  it('distance exacte puis plafond', () => {
    expect(levenshteinCapped('doula', 'douala', 2)).toBe(1);
    expect(levenshteinCapped('douala', 'douala', 2)).toBe(0);
    expect(levenshteinCapped('dschang', 'douala', 2)).toBeGreaterThan(2);
  });
});
