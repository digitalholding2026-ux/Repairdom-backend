import { describe, expect, it } from 'vitest';
import {
  FRAUD_REASON_SAME_TECHNICIAN_48H,
  FRAUD_SAME_TECHNICIAN_WINDOW_MS,
  MIN_MISSION_AMOUNT_XAF,
  REWARD_TIERS,
  highestTier,
  isCountableAmount,
  isRewardTierName,
  isSuspiciousSequence,
  newlyReachedTiers,
  nextTierFor,
} from './rewards.config.js';

/* Règles PURES du programme de récompenses (chantier #4A).
 *
 * Aucun mock ici : `rewards.config.ts` est une feuille sans Prisma ni Nest, ce
 * qui est exactement ce qui permet de le tester sans base ni conteneur. */

describe('REWARD_TIERS', () => {
  it('expose les 4 paliers dans l’ordre croissant des seuils (15/50/150/500)', () => {
    expect(REWARD_TIERS.map((tier) => tier.tier)).toEqual(['BRONZE', 'ARGENT', 'OR', 'PLATINE']);
    expect(REWARD_TIERS.map((tier) => tier.missions)).toEqual([15, 50, 150, 500]);
  });

  it('porte les valeurs cibles validées côté produit', () => {
    expect(REWARD_TIERS.map((tier) => tier.rewardValueXAF)).toEqual([
      5_000, 15_000, 25_000, 200_000,
    ]);
  });

  it('ne contient AUCUN montant formaté dans le libellé (règle FCFA)', () => {
    /* Un montant pré-formaté en base/config serait figé pour tous les
     * utilisateurs ; le formatage FCFA est fait à l'affichage par
     * `formatFCFA`. */
    for (const tier of REWARD_TIERS) {
      expect(tier.reward).not.toMatch(/FCFA/);
      expect(tier.reward).not.toMatch(/\d/);
      expect(Number.isInteger(tier.rewardValueXAF)).toBe(true);
    }
  });
});

describe('MIN_MISSION_AMOUNT_XAF', () => {
  it('vaut 1 500 XAF', () => {
    expect(MIN_MISSION_AMOUNT_XAF).toBe(1_500);
  });
});

describe('isCountableAmount', () => {
  it('compte un montant exactement égal au minimum', () => {
    expect(isCountableAmount(1_500)).toBe(true);
  });

  it('ne compte pas un montant juste en dessous du minimum', () => {
    expect(isCountableAmount(1_499)).toBe(false);
  });

  it('ne compte pas une mission sans montant payé (mission symbolique)', () => {
    expect(isCountableAmount(null)).toBe(false);
    expect(isCountableAmount(undefined)).toBe(false);
  });

  it('rejette un montant non fini (NaN, Infinity)', () => {
    expect(isCountableAmount(Number.NaN)).toBe(false);
    expect(isCountableAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('compte tout montant au-dessus du minimum', () => {
    expect(isCountableAmount(20_000)).toBe(true);
  });
});

describe('isSuspiciousSequence', () => {
  const H = 60 * 60 * 1000;

  it('signale deux missions du même technicien à 1 h d’intervalle', () => {
    expect(isSuspiciousSequence('t1', 't1', H)).toBe(true);
  });

  it('ne signale pas deux techniciens différents', () => {
    expect(isSuspiciousSequence('t1', 't2', H)).toBe(false);
  });

  it('ne signale pas au-delà de la fenêtre de 48 h', () => {
    expect(isSuspiciousSequence('t1', 't1', FRAUD_SAME_TECHNICIAN_WINDOW_MS)).toBe(false);
  });

  it('signale à la seconde près sous la fenêtre', () => {
    expect(
      isSuspiciousSequence('t1', 't1', FRAUD_SAME_TECHNICIAN_WINDOW_MS - 1),
    ).toBe(true);
  });

  it('ne signale pas une mission sans technicien', () => {
    expect(isSuspiciousSequence(null, 't1', H)).toBe(false);
    expect(isSuspiciousSequence('t1', null, H)).toBe(false);
  });

  it('ne signale pas un écart négatif (horodatages incohérents)', () => {
    expect(isSuspiciousSequence('t1', 't1', -1)).toBe(false);
  });
});

describe('newlyReachedTiers', () => {
  it('ne renvoie rien tant qu’aucun palier n’est franchi', () => {
    expect(newlyReachedTiers(0, [])).toEqual([]);
    expect(newlyReachedTiers(14, [])).toEqual([]);
  });

  it('franchit BRONZE à la 15ᵉ mission exactement', () => {
    const reached = newlyReachedTiers(15, []);
    expect(reached.map((t) => t.tier)).toEqual(['BRONZE']);
  });

  it('ne rebranche pas un palier déjà atteint (une seule récompense par palier)', () => {
    expect(newlyReachedTiers(16, ['BRONZE'])).toEqual([]);
    /* ARGENT reste à franchir même si BRONZE est déjà atteint : les paliers
     * sont indépendants, aucun n'est rejoué. */
    expect(newlyReachedTiers(100, ['BRONZE', 'ARGENT'])).toEqual([]);
  });

  it('renvoie TOUS les paliers franchis d’un coup (saut de palier)', () => {
    /* Un client qui passe de 49 à 50 missions franchit ARGENT, mais un client
     * à 1 mission dont on backfill pourrait franchir plusieurs paliers : chacun
     * est une récompense distincte, le client doit tous les voir. */
    const reached = newlyReachedTiers(500, []);
    expect(reached.map((t) => t.tier)).toEqual(['BRONZE', 'ARGENT', 'OR', 'PLATINE']);
  });
});

describe('highestTier', () => {
  it('renvoie NONE sans palier', () => {
    expect(highestTier([])).toBe('NONE');
  });

  it('renvoie le palier le plus élevé, pas le premier de la liste', () => {
    expect(highestTier(['BRONZE', 'OR', 'ARGENT'])).toBe('OR');
    expect(highestTier(['PLATINE'])).toBe('PLATINE');
  });

  it('ignore les paliers inconnus', () => {
    expect(highestTier(['BRONZE', 'DIAMANT'])).toBe('BRONZE');
  });
});

describe('nextTierFor', () => {
  it('renvoie le premier palier non franchi', () => {
    expect(nextTierFor(0)?.tier).toBe('BRONZE');
    expect(nextTierFor(14)?.tier).toBe('BRONZE');
    expect(nextTierFor(15)?.tier).toBe('ARGENT');
    expect(nextTierFor(49)?.remaining).toBe(1);
  });

  it('renvoie null quand tous les paliers sont franchis (aucun reset, donc fini)', () => {
    expect(nextTierFor(500)).toBeNull();
    expect(nextTierFor(9_999)).toBeNull();
  });

  it('ne renvoie jamais un `remaining` négatif', () => {
    expect(nextTierFor(15)?.remaining).toBe(35);
  });
});

describe('isRewardTierName', () => {
  it('accepte les 4 paliers', () => {
    expect(isRewardTierName('BRONZE')).toBe(true);
    expect(isRewardTierName('PLATINE')).toBe(true);
  });

  it('rejette NONE (absence de palier, pas un palier), la casse et l’inconnu', () => {
    expect(isRewardTierName('NONE')).toBe(false);
    expect(isRewardTierName('bronze')).toBe(false);
    expect(isRewardTierName('DIAMANT')).toBe(false);
    expect(isRewardTierName('')).toBe(false);
  });
});

describe('FRAUD_REASON_SAME_TECHNICIAN_48H', () => {
  it('est le motif littéral stocké en base', () => {
    expect(FRAUD_REASON_SAME_TECHNICIAN_48H).toBe('SAME_TECHNICIAN_48H');
  });
});
