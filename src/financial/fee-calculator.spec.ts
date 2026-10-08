import { describe, expect, it } from 'vitest';
import {
  MIN_QUOTE_AMOUNT_ERROR_MESSAGE,
  MIN_QUOTE_AMOUNT_XAF,
  TECHNICIAN_FEE_FIXED_XAF,
  TECHNICIAN_FEE_RATE_DENOMINATOR,
  TECHNICIAN_FEE_RATE_NUMERATOR,
  calculateTechnicianFee,
  isQuoteAmountAllowed,
} from './fee-calculator.js';
import {
  STANDARD_TRANSPORT_FEE,
  computeExpectedTechnicianFee,
  computeGrossAmount,
  computeLegacyRelioCommission,
  computeTechnicianNet,
  isTechnicianFeeReconciled,
} from './financial-fees.js';

/* Chantier 4-FONDATIONS-A — barème de commission technicien.
 *
 * RÈGLE : commission = 500 FCFA + 4 % du MONTANT DU DEVIS. Le transport
 * (2 000 FCFA) est un pass-through intégralement reversé au technicien et
 * n'est JAMAIS commissionné.
 *
 * Les exemples canoniques ci-dessous sont ceux validés par le commanditaire :
 * ils font foi. Un test qui passerait avec 2 % du brut donnerait 540 pour un
 * devis de 25 000 au lieu de 1 500 — d'où des montants écrits en dur.
 *
 * Aucun Prisma, aucun réseau : fonction pure.
 */

describe('calculateTechnicianFee — exemples canoniques', () => {
  const CAS: ReadonlyArray<{ devis: number; commission: number }> = [
    { devis: 5_000, commission: 700 },
    { devis: 10_000, commission: 900 },
    { devis: 15_000, commission: 1_100 },
    { devis: 25_000, commission: 1_500 },
    { devis: 100_000, commission: 4_500 },
  ];

  for (const { devis, commission } of CAS) {
    it(`devis ${devis} → commission ${commission}`, () => {
      expect(calculateTechnicianFee(devis)).toBe(commission);
    });
  }
});

describe('calculateTechnicianFee — formule', () => {
  it('500 FCFA fixes + 4 % du devis', () => {
    expect(TECHNICIAN_FEE_FIXED_XAF).toBe(500);
    expect(TECHNICIAN_FEE_RATE_NUMERATOR).toBe(4);
    expect(TECHNICIAN_FEE_RATE_DENOMINATOR).toBe(100);
    expect(calculateTechnicianFee(37_500)).toBe(500 + 1_500);
  });

  it('la commission ne dépend QUE du devis, jamais du transport', () => {
    // Deux devis identiques donnent la même commission : ajouter le transport
    // ne change rien. C'est la régression centrale du chantier (l'ancien
    // barème était 2 % du BRUT, transport compris).
    const devis = 25_000;
    const commission = calculateTechnicianFee(devis);
    expect(commission).toBe(1_500);
    expect(commission).not.toBe(Math.floor(2 * computeGrossAmount(devis) / 100));
    expect(commission).not.toBe(540);
  });

  it('entier XAF exploitable en Int Prisma, jamais de flottant', () => {
    for (const devis of [5_000, 7_777, 12_345, 25_000, 33_333, 100_000]) {
      const fee = calculateTechnicianFee(devis);
      expect(Number.isInteger(fee)).toBe(true);
      expect(Number.isSafeInteger(fee)).toBe(true);
    }
  });

  it('arrondi demi-supérieur déterministe (entiers, jamais de float)', () => {
    // 1 250 → 50 % de la part proportionnelle : les .5 sont arrondis vers le
    // haut, comme le barème précédent, et les deux appels concordent.
    expect(calculateTechnicianFee(12_500)).toBe(500 + 500);
    expect(calculateTechnicianFee(12_500)).toBe(calculateTechnicianFee(12_500));
  });

  it('montant nul → 500 (part fixe seule)', () => {
    expect(calculateTechnicianFee(0)).toBe(500);
  });

  it('montant non entier ou négatif → refus (jamais de ledger invalide)', () => {
    expect(() => calculateTechnicianFee(2_500.5)).toThrow(/entier XAF/);
    expect(() => calculateTechnicianFee(-1)).toThrow(/entier XAF/);
    expect(() => calculateTechnicianFee(Number.NaN)).toThrow(/entier XAF/);
  });
});

describe('seuil minimum de devis — 5 000 FCFA', () => {
  it('la borne est bien 5 000', () => {
    expect(MIN_QUOTE_AMOUNT_XAF).toBe(5_000);
  });

  it('4 999 → refusé, 5 000 → accepté', () => {
    expect(isQuoteAmountAllowed(4_999)).toBe(false);
    expect(isQuoteAmountAllowed(3_000)).toBe(false);
    expect(isQuoteAmountAllowed(0)).toBe(false);
    expect(isQuoteAmountAllowed(5_000)).toBe(true);
    expect(isQuoteAmountAllowed(25_000)).toBe(true);
  });

  it('le message d\'erreur reste synchronisé avec la constante', () => {
    // Le nombre est écrit en littéral dans le message : ce test empêche la
    // dérive silencieuse si le seuil évolue.
    expect(MIN_QUOTE_AMOUNT_ERROR_MESSAGE).toBe(
      "Le montant minimum d'une intervention est de 5 000 FCFA.",
    );
    expect(MIN_QUOTE_AMOUNT_ERROR_MESSAGE).toContain('5 000');
  });

  it('un montant non entier n\'est jamais « autorisé »', () => {
    expect(isQuoteAmountAllowed(5_000.4)).toBe(false);
  });
});

describe('net technicien — réparation + transport − commission', () => {
  it('devis 25 000 → client paie 27 000, technicien reçoit 25 500', () => {
    expect(computeGrossAmount(25_000)).toBe(27_000);
    expect(computeTechnicianNet(25_000)).toBe(25_500);
  });

  it('table canonique complète', () => {
    const CAS: ReadonlyArray<{ devis: number; clientPaie: number; commission: number; recu: number }> = [
      { devis: 5_000, clientPaie: 7_000, commission: 700, recu: 6_300 },
      { devis: 10_000, clientPaie: 12_000, commission: 900, recu: 11_100 },
      { devis: 15_000, clientPaie: 17_000, commission: 1_100, recu: 15_900 },
      { devis: 25_000, clientPaie: 27_000, commission: 1_500, recu: 25_500 },
      { devis: 100_000, clientPaie: 102_000, commission: 4_500, recu: 97_500 },
    ];
    for (const { devis, clientPaie, commission, recu } of CAS) {
      expect(computeGrossAmount(devis)).toBe(clientPaie);
      expect(calculateTechnicianFee(devis)).toBe(commission);
      expect(computeTechnicianNet(devis)).toBe(recu);
    }
  });

  it('le transport est intégralement reversé : net = brut − commission', () => {
    expect(computeTechnicianNet(15_000)).toBe(17_000 - 1_100);
    expect(STANDARD_TRANSPORT_FEE).toBe(2_000);
  });
});

describe('réconciliation — deux barèmes ont coexisté', () => {
  it('attendu déduit du brut client en retirant le transport', () => {
    // Brut 27 000 → réparation 25 000 → commission attendue 1 500 (PAS 540).
    expect(computeExpectedTechnicianFee(27_000)).toBe(1_500);
    expect(computeExpectedTechnicianFee(7_000)).toBe(700);
  });

  it('une mission réglée sous l\'ancien barème 2 % reste conforme', () => {
    // Mission historique : brut 22 000, commission 2 % = 440. Elle ne doit pas
    // passer « écart » admin du simple fait du changement de barème.
    expect(computeLegacyRelioCommission(22_000)).toBe(440);
    expect(isTechnicianFeeReconciled(22_000, 440)).toBe(true);
  });

  it('une mission réglée sous le nouveau barème est conforme', () => {
    expect(isTechnicianFeeReconciled(27_000, 1_500)).toBe(true);
  });

  it('une commission arbitraire reste un écart', () => {
    expect(isTechnicianFeeReconciled(27_000, 1_500 + 1)).toBe(false);
    expect(isTechnicianFeeReconciled(27_000, 1_400)).toBe(false);
    expect(isTechnicianFeeReconciled(27_000, 0)).toBe(false);
  });

  it('missions legacy (forfait 100 + 150) : la commission historique reste lisible', () => {
    expect(computeLegacyRelioCommission(25_000)).toBe(500);
  });
});