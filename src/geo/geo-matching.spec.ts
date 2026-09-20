import { describe, expect, it } from 'vitest';
import {
  filterActiveCoverageZoneIdsForCity,
  isZoneMatch,
} from './geo-matching.js';

/* Sprint 8.8.2 — Règle B (transition) + GEO-04 (filtrage défensif).
 * Tests purement unitaires : aucune base de données requise. */

describe('isZoneMatch (règle B, ville déjà validée)', () => {
  it('demande sans zone → autorisée, quelle que soit la couverture', () => {
    expect(isZoneMatch(null, [])).toBe(true);
    expect(isZoneMatch(null, ['z1', 'z2'])).toBe(true);
  });

  it('technicien sans couverture active → autorisé en transition', () => {
    expect(isZoneMatch('z1', [])).toBe(true);
  });

  it('même zone couverte → autorisé', () => {
    expect(isZoneMatch('z1', ['z1', 'z2'])).toBe(true);
  });

  it('zone différente → refusé', () => {
    expect(isZoneMatch('z1', ['z2', 'z3'])).toBe(false);
  });
});

describe('filterActiveCoverageZoneIdsForCity (GEO-04)', () => {
  const cityA = 'city-a';
  const cityB = 'city-b';

  it('retient les couvertures actives de la ville courante', () => {
    const result = filterActiveCoverageZoneIdsForCity(
      [
        { zoneId: 'z1', zone: { isActive: true, cityId: cityA } },
        { zoneId: 'z2', zone: { isActive: true, cityId: cityA } },
      ],
      cityA,
    );
    expect(result).toEqual(['z1', 'z2']);
  });

  it('neutralise les couvertures d’une ancienne ville après changement de ville', () => {
    const result = filterActiveCoverageZoneIdsForCity(
      [{ zoneId: 'z1', zone: { isActive: true, cityId: cityA } }],
      cityB,
    );
    expect(result).toEqual([]);
  });

  it('exclut les zones devenues inactives (règle F)', () => {
    const result = filterActiveCoverageZoneIdsForCity(
      [{ zoneId: 'z1', zone: { isActive: false, cityId: cityA } }],
      cityA,
    );
    expect(result).toEqual([]);
  });

  it('profil sans cityId → rien de retenu (transition via isZoneMatch)', () => {
    const result = filterActiveCoverageZoneIdsForCity(
      [{ zoneId: 'z1', zone: { isActive: true, cityId: cityA } }],
      null,
    );
    expect(result).toEqual([]);
  });
});
