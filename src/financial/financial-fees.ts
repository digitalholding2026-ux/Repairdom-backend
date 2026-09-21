/* RÈGLE FINANCIÈRE RELIO — source UNIQUE des montants (backend-authoritative).
 *
 * Pour chaque mission validée comme accomplie :
 *   - le client paie : montant réparation + 2 000 XAF de transport ;
 *   - le client ne paie AUCUNE commission Relio supplémentaire ;
 *   - brut technicien = réparation + 2 000 ;
 *   - commission Relio = 2 % du brut, prélevée auprès du technicien ;
 *   - net technicien = brut − commission.
 *
 * Exemple : réparation 20 000 → brut 22 000 → commission 440 → net 21 560.
 *
 * Montants entiers en XAF. Interdiction de disperser les valeurs dans les
 * services ou le frontend : tout calcul importe depuis ce module.
 *
 * NB : `Pricing.serviceFee` (coût interne d'un tarif catalogue) et
 * `Pricing.travelFee` (snapshot historique) sont des données DISTINCTES et ne
 * doivent jamais être réinterprétées comme le transport standard (2 000).
 */
export const STANDARD_TRANSPORT_FEE = 2_000;

/** Taux de commission Relio prélevée sur le brut technicien (2 %). */
export const RELIO_COMMISSION_RATE_NUMERATOR = 2;
export const RELIO_COMMISSION_RATE_DENOMINATOR = 100;

export const FINANCIAL_CURRENCY = 'XAF';

/* ── Historique (ne plus utiliser pour les nouvelles missions) ──────────
 * Ancien système : CLIENT_PLATFORM_FEE (100) + TECHNICIAN_PLATFORM_FEE (150)
 * = 250 XAF prélevés forfaitairement. Les écritures ledger déjà enregistrées
 * restent immuables et lisibles ; AUCUNE nouvelle écriture ne doit utiliser
 * ces constantes. Conservées uniquement pour la lecture/réconciliation des
 * missions antérieures à la nouvelle règle. */
export const CLIENT_PLATFORM_FEE = 100;
export const TECHNICIAN_PLATFORM_FEE = 150;
export const TOTAL_PLATFORM_FEES = CLIENT_PLATFORM_FEE + TECHNICIAN_PLATFORM_FEE;

/** Arrondi déterministe (demi-supérieur) de la commission Relio en XAF.
 *  Calcul en entiers : (gross × 2 + 50) ÷ 100 — jamais de flottants. */
export function computeRelioCommission(grossAmount: number): number {
  if (!Number.isInteger(grossAmount) || grossAmount < 0) {
    throw new Error('Le montant brut doit être un entier XAF positif ou nul.');
  }
  return Math.floor(
    (grossAmount * RELIO_COMMISSION_RATE_NUMERATOR +
      RELIO_COMMISSION_RATE_DENOMINATOR / 2) /
      RELIO_COMMISSION_RATE_DENOMINATOR,
  );
}

/** Montant brut payé par le client : réparation + transport standard. */
export function computeGrossAmount(repairAmount: number): number {
  if (!Number.isInteger(repairAmount) || repairAmount < 0) {
    throw new Error('Le montant de réparation doit être un entier XAF positif ou nul.');
  }
  return repairAmount + STANDARD_TRANSPORT_FEE;
}

/** Montant net technicien : brut − commission 2 %. */
export function computeTechnicianNet(grossAmount: number): number {
  return grossAmount - computeRelioCommission(grossAmount);
}

/* Provisionnement de compte client pour le simulateur. */
export const DEFAULT_TEST_CREDIT_AMOUNT = 50_000;
export const MAX_TEST_CREDIT_AMOUNT = 1_000_000;