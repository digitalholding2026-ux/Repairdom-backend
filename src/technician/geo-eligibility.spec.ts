import { describe, expect, it } from 'vitest';
import { isGeoEligible } from './technician.service.js';

/* Sprint 8.8.2 — Matrice de matching (règles A + B, verrou 8.8.1 préservé).
 * `isGeoEligible` est le prédicat UNIQUE partagé par `listAvailable`,
 * `getDemandeDetail` et `acceptDemande` : ces tests garantissent la
 * cohérence des trois parcours sans base de données. */

const CITY_A = 'city-a';
const CITY_B = 'city-b';

function eligible(overrides: Partial<Parameters<typeof isGeoEligible>[0]>): boolean {
  return isGeoEligible({
    demandeCityId: CITY_A,
    demandeCity: 'Douala',
    technicianCityId: CITY_A,
    technicianCity: 'Douala',
    demandeZoneId: null,
    technicianActiveZoneIds: [],
    ...overrides,
  });
}

describe('isGeoEligible — matching ville + zone', () => {
  it('même ville + même zone → autorisé', () => {
    expect(eligible({ demandeZoneId: 'z1', technicianActiveZoneIds: ['z1'] })).toBe(true);
  });

  it('même ville + zone différente → refusé', () => {
    expect(eligible({ demandeZoneId: 'z1', technicianActiveZoneIds: ['z2'] })).toBe(false);
  });

  it('demande non zonée → autorisée pour un technicien de la ville', () => {
    expect(eligible({ demandeZoneId: null, technicianActiveZoneIds: ['z1'] })).toBe(true);
  });

  it('technicien sans couverture → autorisé en transition (demande zonée)', () => {
    expect(eligible({ demandeZoneId: 'z1', technicianActiveZoneIds: [] })).toBe(true);
  });

  it('villes structurées différentes → refusé (la zone ne compense jamais)', () => {
    expect(
      eligible({
        demandeCityId: CITY_A,
        technicianCityId: CITY_B,
        demandeZoneId: 'z1',
        technicianActiveZoneIds: ['z1'],
      }),
    ).toBe(false);
  });

  it('cityId différents mais textes égaux → refusé (verrou 8.8.1, pas de fallback)', () => {
    expect(
      eligible({
        demandeCityId: CITY_A,
        demandeCity: 'Douala',
        technicianCityId: CITY_B,
        technicianCity: 'Douala',
      }),
    ).toBe(false);
  });

  it('fallback texte conservé quand un cityId est absent (textes égaux)', () => {
    expect(
      eligible({
        demandeCityId: null,
        demandeCity: '  douala ',
        technicianCityId: CITY_A,
        technicianCity: 'Douala',
      }),
    ).toBe(true);
  });

  it('fallback texte : textes différents sans cityId → refusé', () => {
    expect(
      eligible({
        demandeCityId: null,
        demandeCity: 'Yaoundé',
        technicianCityId: null,
        technicianCity: 'Douala',
      }),
    ).toBe(false);
  });

  it('couverture d’une ancienne ville neutralisée → demande zonée non couverte → refusé', () => {
    // GEO-04 : `activeCoverageZoneIds` ne retient que la ville courante ;
    // ici le technicien (ville B) ne retient rien de l’ancienne ville A.
    expect(
      eligible({
        demandeCityId: CITY_B,
        demandeCity: 'Yaoundé',
        technicianCityId: CITY_B,
        technicianCity: 'Yaoundé',
        demandeZoneId: 'z-a',
        technicianActiveZoneIds: [],
      }),
    ).toBe(true);
    expect(
      eligible({
        demandeCityId: CITY_B,
        demandeCity: 'Yaoundé',
        technicianCityId: CITY_B,
        technicianCity: 'Yaoundé',
        demandeZoneId: 'z-a',
        technicianActiveZoneIds: ['z-b'],
      }),
    ).toBe(false);
  });
});
