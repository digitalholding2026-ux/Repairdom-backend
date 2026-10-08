import { describe, expect, it } from 'vitest';
import {
  CREDIT_PER_TRANCHE_XAF,
  CREDIT_TRANCHE_XAF,
  FRAUD_REASON_SAME_TECHNICIAN_48H,
  FRAUD_SAME_TECHNICIAN_WINDOW_MS,
  MIN_MISSION_AMOUNT_XAF,
  NATURE_THRESHOLDS,
  NATURE_TIER_NAMES,
  REWARD_TIER_NAMES,
  TIER_THRESHOLDS,
  creditsAvailable,
  creditsEarnedForMargin,
  isCountableAmount,
  isNatureTierName,
  isRewardTierName,
  isSuspiciousSequence,
  marginToNextCredit,
  natureTierForMargin,
  newlyReachedNature,
  newlyReachedTiers,
  nextCreditTrancheAt,
  nextNatureThreshold,
  nextTierThreshold,
  tierForMargin,
} from './rewards.config.js';

/* Chantier 4-FONDATIONS-C — barème LTV (fonctions PURES, aucun mock).
 *
 * Le point central du chantier est arithmétique : le coût du programme doit
 * être BORNE à 5 % de la marge à vie. C'est vérifié ici par le rapport
 * crédits/marge, pas seulement par des valeurs figées. */

describe('Barème — plafonnement à 5 % de la marge', () => {
  it('une tranche de 10 000 rapporte 500, soit exactement 5 %', () => {
    expect(CREDIT_TRANCHE_XAF).toBe(10_000);
    expect(CREDIT_PER_TRANCHE_XAF).toBe(500);
    expect((CREDIT_PER_TRANCHE_XAF / CREDIT_TRANCHE_XAF) * 100).toBe(5);
  });

  it('le ratio crédits / marge ne dépasse JAMAIS 5 %', () => {
    /* Balayage large : c'est l'invariant qui rend le programme soutenable. */
    for (const marge of [0, 1, 9_999, 10_000, 25_000, 99_999, 100_000, 1_000_000]) {
      const ratio = creditsEarnedForMargin(marge) / (marge || 1);
      expect(ratio).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('crédits = floor(marge / 10 000) × 500', () => {
    expect(creditsEarnedForMargin(0)).toBe(0);
    expect(creditsEarnedForMargin(9_999)).toBe(0);
    expect(creditsEarnedForMargin(10_000)).toBe(500);
    expect(creditsEarnedForMargin(19_999)).toBe(500);
    expect(creditsEarnedForMargin(20_000)).toBe(1_000);
    expect(creditsEarnedForMargin(11_000)).toBe(500);
    expect(creditsEarnedForMargin(250_000)).toBe(12_500);
  });

  it('marge négative, NaN ou non finie → 0 crédit (jamais de NaN en base)', () => {
    expect(creditsEarnedForMargin(-1)).toBe(0);
    expect(creditsEarnedForMargin(Number.NaN)).toBe(0);
    expect(creditsEarnedForMargin(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('le disponible est la différence, jamais négatif', () => {
    expect(creditsAvailable(1_000, 0)).toBe(1_000);
    expect(creditsAvailable(1_000, 1_000)).toBe(0);
    /* Un état incohérent ne doit jamais produire un disponible négatif. */
    expect(creditsAvailable(500, 1_000)).toBe(0);
  });

  it('la prochaine tranche est le multiple de 10 000 strictement supérieur', () => {
    expect(nextCreditTrancheAt(0)).toBe(10_000);
    expect(nextCreditTrancheAt(9_999)).toBe(10_000);
    expect(nextCreditTrancheAt(10_000)).toBe(20_000);
    expect(nextCreditTrancheAt(11_000)).toBe(20_000);
    expect(marginToNextCredit(11_000)).toBe(9_000);
    expect(marginToNextCredit(0)).toBe(10_000);
    expect(marginToNextCredit(19_000)).toBe(1_000);
  });
});

describe('Paliers badge', () => {
  it('3 paliers sur 10 000 / 50 000 / 100 000 de marge', () => {
    expect(TIER_THRESHOLDS).toEqual([
      { tier: 'FIDELE', margeXAF: 10_000, label: 'Fidèle', emoji: '🥉' },
      { tier: 'OR', margeXAF: 50_000, label: 'Or', emoji: '🥇' },
      { tier: 'PLATINE', margeXAF: 100_000, label: 'Platine', emoji: '💎' },
    ]);
    expect(REWARD_TIER_NAMES).toEqual(['FIDELE', 'OR', 'PLATINE']);
  });

  it('les anciens paliers du #4A ont DISPARU', () => {
    expect(REWARD_TIER_NAMES).not.toContain('BRONZE');
    expect(REWARD_TIER_NAMES).not.toContain('ARGENT');
  });

  it('le niveau courant est le plus haut atteint', () => {
    expect(tierForMargin(0)).toBe('NONE');
    expect(tierForMargin(9_999)).toBe('NONE');
    expect(tierForMargin(10_000)).toBe('FIDELE');
    expect(tierForMargin(49_999)).toBe('FIDELE');
    expect(tierForMargin(50_000)).toBe('OR');
    expect(tierForMargin(99_999)).toBe('OR');
    expect(tierForMargin(100_000)).toBe('PLATINE');
    expect(tierForMargin(5_000_000)).toBe('PLATINE');
  });

  it('un saut de plusieurs paliers les renvoie TOUS', () => {
    const reached = newlyReachedTiers(120_000, []);
    expect(reached.map((t) => t.tier)).toEqual(['FIDELE', 'OR', 'PLATINE']);
  });

  it('un palier déjà atteint n\'est jamais renvoyé deux fois', () => {
    expect(newlyReachedTiers(120_000, ['FIDELE', 'OR', 'PLATINE'])).toEqual([]);
    expect(newlyReachedTiers(60_000, ['FIDELE']).map((t) => t.tier)).toEqual(['OR']);
  });

  it('le prochain palier est null une fois le dernier atteint', () => {
    expect(nextTierThreshold(0)).toBe(10_000);
    expect(nextTierThreshold(49_999)).toBe(50_000);
    expect(nextTierThreshold(50_000)).toBe(100_000);
    expect(nextTierThreshold(100_000)).toBeNull();
    expect(nextTierThreshold(999_999)).toBeNull();
  });
});

describe('Paliers nature (cumulables)', () => {
  it('3 paliers sur 50 000 / 100 000 / 250 000 de marge', () => {
    expect(NATURE_THRESHOLDS).toEqual([
      { tier: 'ELECTROMENAGER_PETIT', margeXAF: 50_000, label: 'Petit électroménager' },
      { tier: 'ELECTROMENAGER_MOYEN', margeXAF: 100_000, label: 'Électroménager moyen' },
      { tier: 'SMARTPHONE', margeXAF: 250_000, label: 'Smartphone' },
    ]);
    expect(NATURE_TIER_NAMES).toEqual([
      'ELECTROMENAGER_PETIT',
      'ELECTROMENAGER_MOYEN',
      'SMARTPHONE',
    ]);
  });

  it('cumulables : les trois peuvent être atteints d\'un coup', () => {
    expect(newlyReachedNature(300_000, []).map((t) => t.tier)).toEqual([
      'ELECTROMENAGER_PETIT',
      'ELECTROMENAGER_MOYEN',
      'SMARTPHONE',
    ]);
    expect(natureTierForMargin(300_000)).toBe('SMARTPHONE');
    expect(natureTierForMargin(49_999)).toBe('NONE');
  });

  it('prochain palier nature null une fois le dernier atteint', () => {
    expect(nextNatureThreshold(0)).toBe(50_000);
    expect(nextNatureThreshold(249_999)).toBe(250_000);
    expect(nextNatureThreshold(250_000)).toBeNull();
  });

  it('un palier nature déjà atteint n\'est pas re-notifié (les autres le sont)', () => {
    /* Les paliers nature sont CUMULABLES : si SMARTPHONE est déjà atteint,
     * les deux autres sont toujours valables. Ce qui ne doit jamais être
     * re-notifié, c'est celui qui est DANS `already`. */
    expect(newlyReachedNature(300_000, ['SMARTPHONE']).map((t) => t.tier)).toEqual([
      'ELECTROMENAGER_PETIT',
      'ELECTROMENAGER_MOYEN',
    ]);
    expect(newlyReachedNature(300_000, [...NATURE_TIER_NAMES])).toEqual([]);
  });
});

describe('Garde-fous conservés du #4A', () => {
  it('montant plancher : 1 500 XAF inclus', () => {
    expect(MIN_MISSION_AMOUNT_XAF).toBe(1_500);
    expect(isCountableAmount(1_499)).toBe(false);
    expect(isCountableAmount(1_500)).toBe(true);
    expect(isCountableAmount(null)).toBe(false);
    expect(isCountableAmount(undefined)).toBe(false);
  });

  it('anti-fraude : même technicien dans une fenêtre de 48 h', () => {
    expect(FRAUD_SAME_TECHNICIAN_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
    expect(FRAUD_REASON_SAME_TECHNICIAN_48H).toBe('SAME_TECHNICIAN_48H');
    expect(isSuspiciousSequence('t1', 't1', 60_000)).toBe(true);
    expect(isSuspiciousSequence('t1', 't1', FRAUD_SAME_TECHNICIAN_WINDOW_MS)).toBe(false);
    expect(isSuspiciousSequence('t1', 't2', 60_000)).toBe(false);
    expect(isSuspiciousSequence(null, 't1', 60_000)).toBe(false);
    /* Un horodatage antérieur (mission rejouée dans le désordre) n'est pas
     * traité comme suspect : la fenêtre est semi-ouverte vers l'avenir. */
    expect(isSuspiciousSequence('t1', 't1', -1)).toBe(false);
  });

  it('validation des noms de palier reçus en endpoint', () => {
    expect(isRewardTierName('OR')).toBe(true);
    expect(isRewardTierName('BRONZE')).toBe(false);
    expect(isRewardTierName('or')).toBe(false);
    expect(isNatureTierName('SMARTPHONE')).toBe(true);
    expect(isNatureTierName('VOITURE')).toBe(false);
  });
});

describe('Règle FCFA — aucun montant formaté dans le barème', () => {
  it('tous les seuils sont des ENTIERS et ne contiennent jamais « FCFA »', () => {
    for (const tier of [...TIER_THRESHOLDS, ...NATURE_THRESHOLDS]) {
      expect(Number.isInteger(tier.margeXAF)).toBe(true);
      expect(String(tier.margeXAF)).not.toMatch(/FCFA|\s/);
    }
    expect(Number.isInteger(CREDIT_TRANCHE_XAF)).toBe(true);
    expect(Number.isInteger(CREDIT_PER_TRANCHE_XAF)).toBe(true);
  });

  it('les libellés ne contiennent AUCUN montant', () => {
    for (const tier of [...TIER_THRESHOLDS, ...NATURE_THRESHOLDS]) {
      expect(tier.label).not.toMatch(/\d/);
    }
  });
});