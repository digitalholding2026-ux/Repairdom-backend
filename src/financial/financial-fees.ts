/* RÈGLE FINANCIÈRE RELIO — source UNIQUE des montants (backend-authoritative).
 *
 * Pour chaque mission validée comme accomplie :
 *   - le client paie : montant réparation + 2 000 XAF de transport ;
 *   - le client ne paie AUCUNE commission Relio supplémentaire ;
 *   - le transport est intégralement reversé au technicien (pass-through) ;
 *   - commission Relio = 500 XAF + 4 % du montant du devis (réparation seule,
 *     JAMAIS du brut qui inclut le transport) ;
 *   - net technicien = réparation + transport − commission.
 *
 * Exemple : réparation 25 000 → client paie 27 000 → commission 1 500 →
 * technicien reçoit 25 000 + 2 000 − 1 500 = 25 500.
 *
 * Le BARÈME lui-même (part fixe, taux, seuil minimum) vit dans
 * `./fee-calculator.ts`, importé ci-dessous puis ré-exporté : il est la source
 * unique du barème, ce fichier celle du transport et des bornes de montants.
 *
 * Montants entiers en XAF. Interdiction de disperser les valeurs dans les
 * services ou le frontend : tout calcul importe depuis ce module.
 *
 * NB : `Pricing.serviceFee` (coût interne d'un tarif catalogue) et
 * `Pricing.travelFee` (snapshot historique) sont des données DISTINCTES et ne
 * doivent jamais être réinterprétées comme le transport standard (2 000).
 */
import { calculateTechnicianFee } from './fee-calculator.js';

export { calculateTechnicianFee } from './fee-calculator.js';
export {
  MIN_QUOTE_AMOUNT_ERROR_MESSAGE,
  MIN_QUOTE_AMOUNT_XAF,
  TECHNICIAN_FEE_FIXED_XAF,
  TECHNICIAN_FEE_RATE_DENOMINATOR,
  TECHNICIAN_FEE_RATE_NUMERATOR,
  isQuoteAmountAllowed,
} from './fee-calculator.js';

export const STANDARD_TRANSPORT_FEE = 2_000;

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

/* ── Barème de commission (chantier 4-FONDATIONS-A) ───────────────────
 * La commission porte sur le MONTANT DU DEVIS (réparation), pas sur le brut
 * technicien qui inclut le transport de 2 000 XAF. `computeTechnicianFee`
 * (source unique, `./fee-calculator.ts`) est le seul calcul appliqué. */

/** Montant brut payé par le client : réparation + transport standard. */
export function computeGrossAmount(repairAmount: number): number {
  if (!Number.isInteger(repairAmount) || repairAmount < 0) {
    throw new Error('Le montant de réparation doit être un entier XAF positif ou nul.');
  }
  return repairAmount + STANDARD_TRANSPORT_FEE;
}

/** Net technicien : réparation + transport − commission. */
export function computeTechnicianNet(repairAmount: number): number {
  return computeGrossAmount(repairAmount) - calculateTechnicianFee(repairAmount);
}

/** Commission attendue à partir d'un brut client déjà débité
 *  (brut = réparation + transport) : on retire le transport, qui n'est jamais
 *  commissionné, puis on applique le barème. */
export function computeExpectedTechnicianFee(grossAmount: number): number {
  return calculateTechnicianFee(Math.max(0, grossAmount - STANDARD_TRANSPORT_FEE));
}

/* ── Réconciliation : deux barèmes ont coexisté en production ──────────
 * Les missions réglées AVANT le chantier 4-FONDATIONS-A portent une
 * commission à 2 % du brut. Elles restent immuables (le ledger n'est jamais
 * réécrit) : la réconciliation administrative doit donc accepter les DEUX
 * règles, sinon toutes les missions historiques passeraient « écart » du
 * simple fait d'un changement de barème. */
const LEGACY_COMMISSION_RATE_NUMERATOR = 2;
const LEGACY_COMMISSION_RATE_DENOMINATOR = 100;

/** Commission historique : 2 % du brut technicien. Lecture/réconciliation
 *  uniquement — AUCUNE nouvelle écriture ne doit l'utiliser. */
export function computeLegacyRelioCommission(grossAmount: number): number {
  if (!Number.isInteger(grossAmount) || grossAmount < 0) {
    throw new Error('Le montant brut doit être un entier XAF positif ou nul.');
  }
  return Math.floor(
    (grossAmount * LEGACY_COMMISSION_RATE_NUMERATOR + LEGACY_COMMISSION_RATE_DENOMINATOR / 2) /
      LEGACY_COMMISSION_RATE_DENOMINATOR,
  );
}

/** Une commission enregistrée est-elle conforme, quel que soit le barème
 *  applicable au moment du règlement ? */
export function isTechnicianFeeReconciled(grossAmount: number, actualFee: number): boolean {
  return (
    actualFee > 0 &&
    (actualFee === computeExpectedTechnicianFee(grossAmount) ||
      actualFee === computeLegacyRelioCommission(grossAmount))
  );
}

/* Provisionnement de compte client pour le simulateur. */
export const DEFAULT_TEST_CREDIT_AMOUNT = 50_000;
export const MAX_TEST_CREDIT_AMOUNT = 1_000_000;

/* ── Retraits des fonds Relio (Sprint ADMIN SUPER POWERS) ──────────── */
export const RELIO_WITHDRAWAL_REFERENCE_PREFIX = 'RELIO-WD-';
export const RELIO_WITHDRAWAL_REFERENCE_LENGTH = 8;
export const RELIO_WITHDRAWAL_REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const RELIO_WITHDRAWAL_NOTE_MAX_LENGTH = 500;
export const RELIO_WITHDRAWAL_MAX_AMOUNT = 1_000_000_000;

/* ── Fondations SasPay (Sprint SASPAY-01) ────────────────────────────
 * Préfixes de références internes (tous UNIQUE en base = idempotence
 * niveau Relio) et bornes de montants. Les références SasPay
 * (transaction ID / reference / external) sont stockées en plus, jamais
 * substituées aux références internes pour la réconciliation. */
export const TOPUP_INTENT_REFERENCE_PREFIX = 'TOPUP-';
export const TOPUP_INTENT_REFERENCE_LENGTH = 12;
export const WITHDRAWAL_REQUEST_REFERENCE_PREFIX = 'WD-';
export const WITHDRAWAL_REQUEST_REFERENCE_LENGTH = 12;
export const FUNDS_HOLD_REFERENCE_PREFIX = 'HOLD-';
export const FUNDS_HOLD_REFERENCE_LENGTH = 12;
export const FINANCIAL_REFERENCE_ALPHABET = RELIO_WITHDRAWAL_REFERENCE_ALPHABET;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/* Recharge client réelle : montant entier XAF strictement positif.
 * Le crédit ledger correspondant (CLIENT_TOPUP) n'est créé qu'au SUCCESS
 * confirmé serveur ; le net constaté (netAmount) fait foi, jamais le seul
 * montant demandé. */
export const MIN_TOPUP_AMOUNT = 100;
export const MAX_TOPUP_AMOUNT = 10_000_000;

/* Retraits client/technicien : le hold garantit disponible ≥ montant sous
 * verrou ; le débit ledger n'est créé qu'au SUCCESS du payout. */
export const MIN_WITHDRAWAL_AMOUNT = 100;
export const MAX_WITHDRAWAL_AMOUNT = 10_000_000;