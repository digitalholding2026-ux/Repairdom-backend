/* Sprint 8.7-FIN — PARAMÈTRES FINANCIERS REPAIRDOM (SIMULATION).
 *
 * Source UNIQUE des frais plateforme RepairDom. Sévérité fixe, montants
 * entiers en XAF. Interdiction de disperser les valeurs « 100 » / « 150 »
 * dans les services : tout calcul les importe depuis ce module.
 *
 * NB : `Pricing.serviceFee` (coût interne d'un tarif catalogue) est une
 * donnée DISTINCTE et ne doit jamais être réinterprétée comme un frais
 * plateforme (100/150).
 */
export const CLIENT_PLATFORM_FEE = 100;
export const TECHNICIAN_PLATFORM_FEE = 150;
export const TOTAL_PLATFORM_FEES = CLIENT_PLATFORM_FEE + TECHNICIAN_PLATFORM_FEE;

export const FINANCIAL_CURRENCY = 'XAF';

/* Provisionnement de compte client pour le simulateur. */
export const DEFAULT_TEST_CREDIT_AMOUNT = 50_000;
export const MAX_TEST_CREDIT_AMOUNT = 1_000_000;