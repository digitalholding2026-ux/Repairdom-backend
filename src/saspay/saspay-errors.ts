/* Sprint SASPAY-03 — Catégorisation des erreurs pay-in (pur, sans I/O).
 *
 * Constat terrain (Orange Money) : SasPay peut répondre « Le service de
 * paiement est momentanément injoignable. » — une indisponibilité TRANSITOIRE
 * du routage, pas un refus définitif. Elle ne doit donc jamais être
 * traitée comme un échec définitif (intention FAILED + « Paiement refusé »),
 * mais comme rejouable (intention PENDING conservée, même Idempotency-Key).
 *
 * Règles :
 *  - le backend conserve le détail technique (HTTP status, code/message
 *    SasPay, transaction ID) dans les logs et `TopupIntent.errorMessage` ;
 *  - le client ne reçoit qu'un `code` machine + un message FR sûr ;
 *  - le payload brut SasPay n'est jamais exposé ;
 *  - un timeout ne bascule jamais en FAILED (SasPay a pu recevoir la
 *    transaction) : PENDING + vérification via la même intention. */

export type TopupUserErrorCode =
  | 'PAYMENT_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'VALIDATION_ERROR'
  | 'COMMUNICATION_ERROR'
  | 'TRANSACTION_UNKNOWN';

export interface TopupPaymentError {
  code: TopupUserErrorCode;
  message: string;
}

export const TOPUP_USER_MESSAGES: Record<TopupUserErrorCode, string> = {
  PAYMENT_FAILED:
    "Le paiement n'a pas abouti. Aucun crédit n'a été ajouté à votre solde Relio.",
  PROVIDER_UNAVAILABLE:
    'Le service de paiement est momentanément indisponible. Veuillez réessayer dans quelques instants.',
  VALIDATION_ERROR:
    'Les informations de paiement sont invalides. Vérifiez le réseau, le numéro et le montant.',
  COMMUNICATION_ERROR:
    "Nous n'avons pas pu confirmer la communication avec le service de paiement. Vérifiez le statut de votre recharge avant de recommencer.",
  TRANSACTION_UNKNOWN:
    'Transaction introuvable côté service de paiement. Vérifiez le statut avant toute nouvelle tentative.',
};

/** Codes SasPay métier correspondant à une erreur de validation côté
 *  demande (réseau inactif, client/numéro, pays, méthode manquante). */
const VALIDATION_CODES = new Set([
  'invalid_method',
  'invalid_customer',
  'invalid_country',
  'missing_method',
]);

const VALIDATION_MESSAGES: Record<string, string> = {
  invalid_method:
    'Ce réseau mobile money est momentanément indisponible. Réessayez ou choisissez un autre réseau.',
  invalid_customer:
    'Le numéro mobile money semble invalide. Vérifiez-le et réessayez.',
  invalid_country: 'Pays non pris en charge pour ce paiement.',
  missing_method: 'Moyen de paiement manquant. Reprenez la recharge.',
};

/** Formulations SasPay signalant une indisponibilité transitoire du routage
 *  (quel que soit le statut HTTP) : toujours rejouables, jamais FAILED. */
const TRANSIENT_PATTERNS = [
  /momentan[eé]ment indisponible/i,
  /momentan[eé]ment injoignable/i,
  /injoignable/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /temporairement indisponible/i,
  /no_route_available/i,
  /no_exchange_rate/i,
];

export function isTransientProviderMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Un message SasPay n'est répercuté tel quel que s'il est court, sans
 *  secret ni structure technique ; sinon le texte de catégorie s'applique. */
export function isSafeUserMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const clean = message.trim();
  if (clean.length === 0 || clean.length > 200) return false;
  if (/sk_(live|test)_/i.test(clean)) return false;
  if (/authorization|bearer|secret|password|token/i.test(clean)) return false;
  if (/[{}[\]]/.test(clean)) return false;
  return true;
}

export type InitRejectionOutcome = 'retryable' | 'failed' | 'validation';

export interface InitRejection {
  outcome: InitRejectionOutcome;
  error: TopupPaymentError;
}

/** Classe un refus d'initialisation SasPay (HTTP + code + message) :
 *  - 5xx ou formulation transitoire (ex. Orange « momentanément
 *    injoignable ») → `retryable` (PENDING conservé) ;
 *  - code de validation connu → `validation` (FAILED + texte ciblé) ;
 *  - 409 conflit de clé → `failed` (la clé est liée à un autre contenu) ;
 *  - autres 4xx / refus → `failed` (message SasPay sûr si disponible,
 *    sinon texte générique — jamais inventé). */
export function classifyInitRejection(
  httpStatus: number,
  saspayCode: string | null,
  saspayMessage: string | null,
): InitRejection {
  if (httpStatus >= 500 || isTransientProviderMessage(saspayMessage)) {
    return {
      outcome: 'retryable',
      error: { code: 'PROVIDER_UNAVAILABLE', message: TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE },
    };
  }
  if (httpStatus === 429) {
    return {
      outcome: 'retryable',
      error: { code: 'PROVIDER_UNAVAILABLE', message: TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE },
    };
  }
  if (saspayCode && VALIDATION_CODES.has(saspayCode)) {
    return {
      outcome: 'validation',
      error: {
        code: 'VALIDATION_ERROR',
        message: VALIDATION_MESSAGES[saspayCode] ?? TOPUP_USER_MESSAGES.VALIDATION_ERROR,
      },
    };
  }
  if (isSafeUserMessage(saspayMessage)) {
    return {
      outcome: 'failed',
      error: { code: 'PAYMENT_FAILED', message: saspayMessage as string },
    };
  }
  return {
    outcome: 'failed',
    error: { code: 'PAYMENT_FAILED', message: TOPUP_USER_MESSAGES.PAYMENT_FAILED },
  };
}

/** Message utilisateur sûr dérivé d'une intention (statut + raison technique
 *  stockée). Utilisé pour `TopupIntent.userMessage` exposé à l'UI. */
export function topupUserMessage(status: string, errorMessage: string | null): string | null {  if (status === 'SUCCESS') return 'Recharge confirmée — votre solde a été crédité.';
  if (status === 'PENDING') return 'Paiement en attente de confirmation.';
  if (status === 'CANCELLED') return 'Paiement annulé — aucun débit.';
  if (status !== 'FAILED') return null;
  if (isTransientProviderMessage(errorMessage)) {
    return TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE;
  }
  if (errorMessage?.includes('invalid_method')) {
    return VALIDATION_MESSAGES.invalid_method;
  }
  if (errorMessage?.includes('invalid_customer')) {
    return VALIDATION_MESSAGES.invalid_customer;
  }
  return TOPUP_USER_MESSAGES.PAYMENT_FAILED;
}

/* ── Sprint PAYOUT — mêmes principes côté retrait (section additive, le
 *  pay-in ci-dessus est inchangé) : détail technique en logs +
 *  WithdrawalRequest.errorMessage, message sûr pour l'UI, payload brut
 *  jamais exposé, timeout jamais converti en FAILED. */

export type PayoutUserErrorCode =
  | 'WITHDRAWAL_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'VALIDATION_ERROR'
  | 'COMMUNICATION_ERROR'
  | 'TRANSACTION_UNKNOWN';

export interface PayoutPaymentError {
  code: PayoutUserErrorCode;
  message: string;
}

export const PAYOUT_USER_MESSAGES: Record<PayoutUserErrorCode, string> = {
  WITHDRAWAL_FAILED:
    "Le retrait n'a pas abouti. Aucun montant n'a été débité de votre solde Relio.",
  PROVIDER_UNAVAILABLE:
    'Le service de paiement est momentanément indisponible. Votre retrait reste en attente, réessayez dans quelques instants.',
  VALIDATION_ERROR:
    'Les informations de retrait sont invalides. Vérifiez le réseau, le numéro bénéficiaire et le montant.',
  COMMUNICATION_ERROR:
    "Nous n'avons pas pu confirmer la communication avec le service de paiement. Vérifiez le statut de votre retrait avant de recommencer.",
  TRANSACTION_UNKNOWN:
    'Transaction introuvable côté service de paiement. Vérifiez le statut avant toute nouvelle tentative.',
};

/** Codes SasPay métier correspondant à une erreur de validation de la
 *  demande de payout (réseau inactif, bénéficiaire, pays, devise/pays,
 *  méthode manquante). */
const PAYOUT_VALIDATION_CODES = new Set([
  'invalid_method',
  'invalid_customer',
  'invalid_country',
  'currency_country_mismatch',
  'missing_method',
]);

const PAYOUT_VALIDATION_MESSAGES: Record<string, string> = {
  invalid_method:
    'Ce réseau mobile money est momentanément indisponible pour les retraits. Réessayez ou choisissez un autre réseau.',
  invalid_customer:
    'Le numéro mobile money bénéficiaire semble invalide. Vérifiez-le et réessayez.',
  invalid_country: 'Pays non pris en charge pour ce retrait.',
  currency_country_mismatch: 'Incohérence devise/pays pour ce retrait.',
  missing_method: 'Moyen de paiement manquant. Reprenez le retrait.',
};

export type PayoutRejectionOutcome = 'retryable' | 'failed' | 'validation';

export interface PayoutRejection {
  outcome: PayoutRejectionOutcome;
  error: PayoutPaymentError;
}

/** Classe un refus d'init payout (HTTP + code + message) :
 *  - 5xx, 429 ou formulation transitoire → `retryable` (PENDING conservé,
 *    même Idempotency-Key au retry) ;
 *  - `ip_not_whitelisted` (403, aucune IP whitelistée), fonctionnalité
 *    désactivée ou scope insuffisant → `failed` avec message explicite et
 *    sûr (correction côté dashboard, pas de retry identique utile) ;
 *  - code de validation connu → `validation` (FAILED + texte ciblé) ;
 *  - 409 conflit de clé → `failed` ;
 *  - autres 4xx → `failed` (message SasPay sûr si disponible, sinon texte
 *    générique — jamais inventé). */
export function classifyPayoutRejection(
  httpStatus: number,
  saspayCode: string | null,
  saspayMessage: string | null,
): PayoutRejection {
  if (httpStatus >= 500 || httpStatus === 429 || isTransientProviderMessage(saspayMessage)) {
    return {
      outcome: 'retryable',
      error: { code: 'PROVIDER_UNAVAILABLE', message: PAYOUT_USER_MESSAGES.PROVIDER_UNAVAILABLE },
    };
  }
  if (saspayCode === 'ip_not_whitelisted') {
    return {
      outcome: 'failed',
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        message:
          "Retraits temporairement indisponibles (configuration du service de paiement). Votre demande est conservée en échec sans débit, réessayez plus tard.",
      },
    };
  }
  if (saspayCode && PAYOUT_VALIDATION_CODES.has(saspayCode)) {
    return {
      outcome: 'validation',
      error: {
        code: 'VALIDATION_ERROR',
        message: PAYOUT_VALIDATION_MESSAGES[saspayCode] ?? PAYOUT_USER_MESSAGES.VALIDATION_ERROR,
      },
    };
  }
  if (isSafeUserMessage(saspayMessage)) {
    return {
      outcome: 'failed',
      error: { code: 'WITHDRAWAL_FAILED', message: saspayMessage as string },
    };
  }
  return {
    outcome: 'failed',
    error: { code: 'WITHDRAWAL_FAILED', message: PAYOUT_USER_MESSAGES.WITHDRAWAL_FAILED },
  };
}

/** Message utilisateur sûr dérivé d'une demande de retrait (statut +
 *  raison technique stockée). Exposé via `WithdrawalRequest.userMessage`. */
export function payoutUserMessage(status: string, errorMessage: string | null): string | null {
  if (status === 'SUCCESS') return 'Retrait confirmé.';
  if (status === 'PENDING') return 'Retrait en attente de confirmation.';
  if (status === 'CANCELLED') return 'Retrait annulé — aucun débit.';
  if (status !== 'FAILED') return null;
  if (isTransientProviderMessage(errorMessage)) {
    return PAYOUT_USER_MESSAGES.PROVIDER_UNAVAILABLE;
  }
  if (errorMessage?.includes('invalid_method')) {
    return PAYOUT_VALIDATION_MESSAGES.invalid_method;
  }
  if (errorMessage?.includes('invalid_customer')) {
    return PAYOUT_VALIDATION_MESSAGES.invalid_customer;
  }
  return PAYOUT_USER_MESSAGES.WITHDRAWAL_FAILED;
}
