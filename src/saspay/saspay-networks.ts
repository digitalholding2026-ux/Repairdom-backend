/* Sprint SASPAY-03 — Référentiel pay-in Relio (backend = autorité).
 *
 * Marché camerounais : pays CM, devise XAF, réseaux actifs `mtn_cm` et
 * `orange_cm` (catalogue statique SasPay ; `eu_mobile_cm` est inactif et
 * renverrait `invalid_method` 422). Le frontend ne choisit jamais hors de
 * cette liste ; l'état réel reste vérifiable via GET /networks côté SasPay
 * (non appelé à chaque paiement pour respecter les limites API).
 * Doc : https://docs.saspay.me/api-reference/reference/formats */

export const SASPAY_TOPUP_COUNTRY = 'CM';
export const SASPAY_TOPUP_CURRENCY = 'XAF';
export const SASPAY_TOPUP_NETWORKS = ['mtn_cm', 'orange_cm'] as const;
export type SasPayTopupNetwork = (typeof SASPAY_TOPUP_NETWORKS)[number];

/** Réseau actif éligible au pay-in. */
export function isSupportedTopupNetwork(value: unknown): value is SasPayTopupNetwork {
  return (
    typeof value === 'string' &&
    (SASPAY_TOPUP_NETWORKS as readonly string[]).includes(value)
  );
}

/* Sprint PAYOUT — le payout utilise les mêmes codes réseau (`method`) que le
 * pay-in (`network`) : mtn_cm / orange_cm, pays CM, devise XAF (doc SasPay :
 * mismatch devise/pays rejeté en 422, sans conversion). Alias explicites
 * pour la lisibilité du flux retrait. */
export const SASPAY_PAYOUT_COUNTRY = SASPAY_TOPUP_COUNTRY;
export const SASPAY_PAYOUT_CURRENCY = SASPAY_TOPUP_CURRENCY;
export const SASPAY_PAYOUT_NETWORKS = SASPAY_TOPUP_NETWORKS;
export type SasPayPayoutNetwork = SasPayTopupNetwork;

/** Réseau actif éligible au payout. */
export function isSupportedPayoutNetwork(value: unknown): value is SasPayPayoutNetwork {
  return isSupportedTopupNetwork(value);
}

/** Normalise un numéro de téléphone (espaces/points/tirets retirés).
 *  Retourne null si le format de base est invalide (le gateway reste seul
 *  juge de l'existence réelle du numéro). */
export function normalizeMsisdn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\s.\-()]/g, '');
  if (!/^\+?[0-9]{9,15}$/.test(clean)) return null;
  return clean;
}

/** Code réseau/devise plausible (exclut les UUID renvoyés par /verify/). */
export function asShortCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(clean) || clean.includes('-')) return null;
  return clean;
}
