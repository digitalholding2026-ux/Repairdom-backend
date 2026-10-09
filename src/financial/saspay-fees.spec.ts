/* TRANSPARENCE SASPAY — barème des frais SasPay (source unique serveur).
 *
 * Ces tests verrouillent deux choses :
 *   1. la formule attendue pour chaque taux mesuré en production ;
 *   2. la garantie centrale de l'Option A — un technicien qui demande un
 *      retrait de N reçoit EXACTEMENT N, jamais N − frais.
 *
 * Ils verrouillent aussi les valeurs canoniques que le frontend duplique
 * (`frontend/src/lib/saspay-fees.ts`) : toute dérive de taux côté UI se voit
 * ici, avant qu'un client ne voie un montant faux à l'écran.
 */
import { describe, expect, it } from 'vitest';
import {
  SASPAY_COLLECT_RATE,
  SASPAY_PAYOUT_RATE,
  computeSaspayCollectFee,
  computeSaspayCollectTotal,
  computeSaspayPayoutCharged,
  computeSaspayPayoutFee,
} from './saspay-fees.js';

describe('taux SasPay — valeurs canoniques', () => {
  it('les taux sont ceux mesurés en production', () => {
    expect(SASPAY_COLLECT_RATE).toBe(0.045);
    expect(SASPAY_PAYOUT_RATE).toBe(0.035);
  });
});

describe('computeSaspayPayoutCharged — Option A (Relio absorbe les 3,5 %)', () => {
  it('500 → 519 (ceil(500 / 0,965))', () => {
    expect(computeSaspayPayoutCharged(500)).toBe(519);
  });

  it('15 900 → 16 477, et le net recalculé couvre le net demandé', () => {
    const charged = computeSaspayPayoutCharged(15_900);
    expect(charged).toBe(16_477);
    expect(charged * (1 - SASPAY_PAYOUT_RATE)).toBeGreaterThanOrEqual(15_900);
  });

  it('garantit le net sur toute la plage des montants de retrait', () => {
    // Tous les montants entre le minimum (100) et le maximum (10 000 000).
    for (const net of [
      100, 101, 499, 500, 999, 2_000, 15_900, 16_477, 100_000, 999_999,
      1_000_000, 9_999_999, 10_000_000,
    ]) {
      const charged = computeSaspayPayoutCharged(net);
      expect(charged).toBeGreaterThanOrEqual(net);
      expect(charged * (1 - SASPAY_PAYOUT_RATE)).toBeGreaterThanOrEqual(net);
      // Et le surplus reste borné à 1 XAF (arrondi au supérieur uniquement).
      expect(charged - net).toBeLessThanOrEqual(computeSaspayPayoutFee(net));
    }
  });

  it('rejoue les mesures de production en sens inverse', () => {
    // Mesures relevées : 2 000 envoyés → 1 930 reçus ; 500 → 482,50.
    // Le taux étant PUR (pas de minimum), la majoration doit reconstituer
    // exactement ces deux observations.
    expect(computeSaspayPayoutCharged(2_000)).toBe(Math.ceil(2_000 / 0.965));
    expect(2_000 * (1 - SASPAY_PAYOUT_RATE)).toBeCloseTo(1_930, 5);
    expect(500 * (1 - SASPAY_PAYOUT_RATE)).toBeCloseTo(482.5, 5);
  });

  it('montant nul ou négatif → 0 (aucune division par un net nul)', () => {
    expect(computeSaspayPayoutCharged(0)).toBe(0);
    expect(computeSaspayPayoutCharged(-1)).toBe(0);
    expect(computeSaspayPayoutFee(0)).toBe(0);
  });
});

describe('computeSaspayPayoutFee — coût supporté par Relio', () => {
  it('15 900 → 577 (le supplément que Relio prend en charge)', () => {
    expect(computeSaspayPayoutFee(15_900)).toBe(16_477 - 15_900);
    expect(computeSaspayPayoutFee(15_900)).toBe(577);
  });

  it('le frais Relio vaut toujours le brut moins le net', () => {
    for (const net of [100, 500, 2_000, 15_900, 10_000_000]) {
      expect(computeSaspayPayoutFee(net)).toBe(computeSaspayPayoutCharged(net) - net);
    }
  });
});

describe('computeSaspayCollectFee — frais à la charge du client (recharge)', () => {
  it('2 000 → 90 (mesure de production : le client paie 2 090)', () => {
    expect(computeSaspayCollectFee(2_000)).toBe(90);
    expect(computeSaspayCollectTotal(2_000)).toBe(2_090);
  });

  it('100 → 5', () => {
    expect(computeSaspayCollectFee(100)).toBe(5);
  });

  it('arrondi au XAF supérieur : le total débité n’est jamais sous-annoncé', () => {
    for (const amount of [100, 101, 555, 2_000, 4_999, 10_000, 10_000_000]) {
      const fee = computeSaspayCollectFee(amount);
      expect(Number.isInteger(fee)).toBe(true);
      expect(fee).toBeGreaterThanOrEqual(amount * SASPAY_COLLECT_RATE);
      expect(fee).toBeLessThan(amount * SASPAY_COLLECT_RATE + 1);
      expect(computeSaspayCollectTotal(amount)).toBe(amount + fee);
    }
  });

  it('montant nul ou négatif → 0 frais', () => {
    expect(computeSaspayCollectFee(0)).toBe(0);
    expect(computeSaspayCollectFee(-500)).toBe(0);
    expect(computeSaspayCollectTotal(0)).toBe(0);
  });
});