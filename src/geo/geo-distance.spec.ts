import { describe, expect, it } from 'vitest';
import {
  demandeTechnicianDistanceMeters,
  haversineMeters,
  isValidCoordinates,
  isValidLatitude,
  isValidLongitude,
} from './geo-distance.js';

/* GPS V1 — Haversine local, déterministe, sans appel externe. */

describe('validateurs de coordonnées', () => {
  it('latitudes valides aux bornes', () => {
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(4.05)).toBe(true);
  });

  it('latitudes hors limites rejetées', () => {
    expect(isValidLatitude(-90.0001)).toBe(false);
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLatitude(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidLatitude('4')).toBe(false);
    expect(isValidLatitude(null)).toBe(false);
    expect(isValidLatitude(undefined)).toBe(false);
  });

  it('longitudes valides aux bornes', () => {
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(180)).toBe(true);
    expect(isValidLongitude(9.7)).toBe(true);
  });

  it('longitudes hors limites rejetées', () => {
    expect(isValidLongitude(-180.1)).toBe(false);
    expect(isValidLongitude(180.1)).toBe(false);
    expect(isValidLongitude(Number.NaN)).toBe(false);
    expect(isValidLongitude(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('coordonnées complètes', () => {
    expect(isValidCoordinates({ latitude: 4.05, longitude: 9.7 })).toBe(true);
    expect(isValidCoordinates({ latitude: 4.05 })).toBe(false);
    expect(isValidCoordinates(null)).toBe(false);
    expect(isValidCoordinates(undefined)).toBe(false);
  });
});

describe('haversineMeters', () => {
  it('même point → 0', () => {
    expect(haversineMeters({ latitude: 4.05, longitude: 9.7 }, { latitude: 4.05, longitude: 9.7 })).toBe(0);
  });

  it('1 degré de longitude à l’équateur ≈ 111 km', () => {
    const distance = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    expect(distance).not.toBeNull();
    expect(Math.abs((distance as number) - 111195)).toBeLessThan(500);
  });

  it('Douala → Yaoundé ≈ 200 km (ordre de grandeur)', () => {
    const distance = haversineMeters(
      { latitude: 4.05, longitude: 9.68 },
      { latitude: 3.87, longitude: 11.52 },
    );
    expect(distance).not.toBeNull();
    expect(distance as number).toBeGreaterThan(150000);
    expect(distance as number).toBeLessThan(260000);
  });

  it('résultat entier fini, jamais NaN/Infinity', () => {
    const distance = haversineMeters({ latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 });
    expect(distance).not.toBeNull();
    expect(Number.isInteger(distance)).toBe(true);
    expect(Number.isFinite(distance)).toBe(true);
  });

  it('coordonnées absentes ou invalides → null', () => {
    expect(haversineMeters(null, { latitude: 0, longitude: 0 })).toBeNull();
    expect(haversineMeters({ latitude: 0, longitude: 0 }, undefined)).toBeNull();
    expect(
      haversineMeters({ latitude: 100, longitude: 0 }, { latitude: 0, longitude: 0 }),
    ).toBeNull();
    expect(
      haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 200 }),
    ).toBeNull();
  });
});

describe('demandeTechnicianDistanceMeters', () => {
  it('les deux positions présentes → distance', () => {
    expect(
      demandeTechnicianDistanceMeters(
        { latitude: 4.05, longitude: 9.7 },
        { lastLatitude: 4.05, lastLongitude: 9.7 },
      ),
    ).toBe(0);
  });

  it('position manquante d’un côté → null (jamais d’exception)', () => {
    expect(
      demandeTechnicianDistanceMeters(
        { latitude: null, longitude: null },
        { lastLatitude: 4.05, lastLongitude: 9.7 },
      ),
    ).toBeNull();
    expect(
      demandeTechnicianDistanceMeters(
        { latitude: 4.05, longitude: 9.7 },
        { lastLatitude: null, lastLongitude: null },
      ),
    ).toBeNull();
    expect(demandeTechnicianDistanceMeters(null, { lastLatitude: 4, lastLongitude: 9 })).toBeNull();
    expect(demandeTechnicianDistanceMeters({ latitude: 4, longitude: 9 }, null)).toBeNull();
  });
});
