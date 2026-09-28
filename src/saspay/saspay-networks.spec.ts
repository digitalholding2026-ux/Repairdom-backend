import { describe, expect, it } from 'vitest';
import { normalizeMsisdn } from './saspay-networks.js';

/* CHANTIER PAIEMENT P0/P1 — normalisation E.164 camerounaise.
 * `690000000`, `237690000000` et `+237690000000` convergent vers
 * `+237690000000` (convention déjà stockée/transmise à SasPay).
 * Aucune opération réelle, pur unit test. */

describe('normalizeMsisdn (chantier paiement)', () => {
  it('numéro local 9 chiffres → préfixe +237', () => {
    expect(normalizeMsisdn('690000000')).toBe('+237690000000');
    expect(normalizeMsisdn('677889900')).toBe('+237677889900');
  });

  it('numéro avec indicatif sans + → + ajouté, sans doublon', () => {
    expect(normalizeMsisdn('237690000000')).toBe('+237690000000');
  });

  it('numéro déjà normalisé → inchangé (jamais de double 237)', () => {
    expect(normalizeMsisdn('+237690000000')).toBe('+237690000000');
    const once = normalizeMsisdn('690000000');
    expect(normalizeMsisdn(once)).toBe('+237690000000');
  });

  it('séparateurs courants tolérés', () => {
    expect(normalizeMsisdn('+237 690 00 00 00')).toBe('+237690000000');
    expect(normalizeMsisdn('690-00-00-00')).toBe('+237690000000');
    expect(normalizeMsisdn('(690) 000 000')).toBe('+237690000000');
  });

  it('numéros invalides → null', () => {
    expect(normalizeMsisdn('abc')).toBeNull();
    expect(normalizeMsisdn('12')).toBeNull();
    expect(normalizeMsisdn('12345678')).toBeNull();
    expect(normalizeMsisdn('1234567890123456')).toBeNull();
    expect(normalizeMsisdn('')).toBeNull();
    expect(normalizeMsisdn('   ')).toBeNull();
    expect(normalizeMsisdn(null)).toBeNull();
    expect(normalizeMsisdn(undefined)).toBeNull();
    expect(normalizeMsisdn(690000000)).toBeNull();
    expect(normalizeMsisdn('+237 69A 00 00 00')).toBeNull();
  });
});
