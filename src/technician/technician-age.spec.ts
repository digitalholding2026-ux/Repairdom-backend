import { describe, expect, it } from 'vitest';
import {
  TECHNICIAN_MINIMUM_AGE,
  computeAge,
  isAtLeastAge,
  parseBirthDate,
} from './technician-age.js';

/* §11 — majorité. Le cas critique est le calcul EXACT : `année courante -
 * année de naissance` autoriserait un mineur le jour de son 18e anniversaire
 * (ou pire, pendant plusieurs mois). */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('computeAge — date complète (jour + mois)', () => {
  it('anniversaire déjà passé cette année → âgepile', () => {
    // Né le 04/10/2000, on est le 04/10/2018 : 18 ans pile.
    expect(computeAge(d('2000-10-04'), d('2018-10-04'))).toBe(18);
  });

  it('anniversaire le jour même → âge pile (jour ET mois pris en compte)', () => {
    expect(computeAge(d('2007-01-15'), d('2025-01-15'))).toBe(18);
  });

  it('anniversaire dans 1 jour → un an de moins', () => {
    expect(computeAge(d('2007-01-16'), d('2025-01-15'))).toBe(17);
  });

  it('mois de naissance postérieur → un an de moins (piège classique)', () => {
    // Né en décembre, on est en octobre : 17 ans, PAS 18.
    expect(computeAge(d('2007-12-31'), d('2025-10-04'))).toBe(17);
  });

  it('29 février en année non bissextile → anniversaire NON atteint au 28/02', () => {
    // 2025 n'est pas bissextile : au 28/02/2025, un né le 29/02/2008 a 16 ans
    // (le 29/02/2025 n'existe pas). Une implémentation naïve dirait 17.
    expect(computeAge(d('2008-02-29'), d('2025-02-28'))).toBe(16);
    expect(computeAge(d('2008-02-29'), d('2025-03-01'))).toBe(17);
  });

  it('29 février en année bissextile → pile au 29/02', () => {
    expect(computeAge(d('2008-02-29'), d('2024-02-29'))).toBe(16);
  });

  it('né aujourd’hui → 0 an', () => {
    expect(computeAge(d('2025-10-04'), d('2025-10-04'))).toBe(0);
  });

  it('date future → null (jamais un âge négatif)', () => {
    expect(computeAge(d('2026-01-01'), d('2025-10-04'))).toBeNull();
  });

  it('date invalide → null', () => {
    expect(computeAge(new Date('nope'), new Date())).toBeNull();
  });

  it('indépendant de l’heure : 23h59 et 00h00 le même jour donnent le même âge', () => {
    expect(computeAge(d('2007-10-05'), new Date('2025-10-04T23:59:59Z'))).toBe(17);
    expect(computeAge(d('2007-10-05'), new Date('2025-10-04T00:00:00Z'))).toBe(17);
  });
});

describe('isAtLeastAge — contrôle de majorité (18 ans)', () => {
  it('moins de 18 ans → bloqué', () => {
    expect(isAtLeastAge(d('2007-10-05'), TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(false);
    expect(isAtLeastAge(d('2010-01-01'), TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(false);
  });

  it('exactement 18 ans le jour de l’anniversaire → accepté', () => {
    expect(isAtLeastAge(d('2007-10-04'), TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(true);
  });

  it('majeur (largement) → accepté', () => {
    expect(isAtLeastAge(d('1990-05-20'), TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(true);
  });

  it('date de naissance absente → bloqué (faux par défaut, jamais true)', () => {
    expect(isAtLeastAge(null, TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(false);
    expect(isAtLeastAge(undefined, TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(false);
  });

  it('18 ans + 364 jours → encore bloqué ; 19 ans → accepté', () => {
    expect(isAtLeastAge(d('2007-10-05'), TECHNICIAN_MINIMUM_AGE, d('2025-10-03'))).toBe(false);
    expect(isAtLeastAge(d('2006-10-05'), TECHNICIAN_MINIMUM_AGE, d('2025-10-04'))).toBe(true);
  });
});

describe('parseBirthDate — validation de la saisie', () => {
  it('accepte YYYY-MM-DD → Date UTC-minuit', () => {
    const parsed = parseBirthDate('1995-03-07');
    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe('1995-03-07T00:00:00.000Z');
  });

  it('accepte un objet Date existant', () => {
    expect(parseBirthDate(d('1995-03-07'))?.toISOString()).toBe('1995-03-07T00:00:00.000Z');
  });

  it('refuse les formats non ISO', () => {
    expect(parseBirthDate('07/03/1995')).toBeNull();
    expect(parseBirthDate('1995-3-7')).toBeNull();
    expect(parseBirthDate('1995/03/07')).toBeNull();
    expect(parseBirthDate('')).toBeNull();
    expect(parseBirthDate(19950307)).toBeNull();
    expect(parseBirthDate(null)).toBeNull();
  });

  it('refuse les dates impossibles (débordement)', () => {
    expect(parseBirthDate('1995-02-31')).toBeNull();
    expect(parseBirthDate('1995-13-01')).toBeNull();
    expect(parseBirthDate('1995-00-10')).toBeNull();
    expect(parseBirthDate('1995-04-31')).toBeNull();
  });

  it('refuse les années aberrantes', () => {
    expect(parseBirthDate('1899-12-31')).toBeNull();
    expect(parseBirthDate('2999-01-01')).toBeNull();
  });

  it('accepte un 29 février (année bissextile)', () => {
    expect(parseBirthDate('2008-02-29')).not.toBeNull();
    // 2025 n'est pas bissextile → refusé.
    expect(parseBirthDate('2025-02-29')).toBeNull();
  });

  it('Date invalide → null', () => {
    expect(parseBirthDate(new Date('pas une date'))).toBeNull();
  });
});