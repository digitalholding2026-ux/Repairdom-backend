import { Injectable, Logger } from '@nestjs/common';
import { SasPayConfig } from './saspay.config.js';

/* Sprint SASPAY-03 — Client HTTP SasPay minimal (pay-in uniquement).
 *
 * Endpoints utilisés (doc https://docs.saspay.me, base
 * https://api.saspay.me/api/v1, Bearer sk_...) :
 *   POST /payments/softpay/         — init push/checkout (Idempotency-Key)
 *   GET  /payments/{id}/verify/     — revérification serveur (pas de polling)
 * Payment Links, payouts et checkout-sessions : HORS PÉRIMÈTRE.
 *
 * Montants : l'API attend des décimaux en string ("2500.00") et renvoie de
 * même ; ce client convertit vers/depuis des entiers XAF. `fetch` global
 * (Node 22), timeout 15 s, aucune dépendance HTTP externe. */

export const SASPAY_REQUEST_TIMEOUT_MS = 15000;
export const SASPAY_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface SoftpayCustomer {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
}

export interface SoftpayInitInput {
  amountMinor: number;
  currency: string;
  country: string;
  network: string;
  description: string;
  customer: SoftpayCustomer;
  metadata?: Record<string, string>;
  returnUrl?: string | null;
  idempotencyKey: string;
}

export interface SoftpayInitResult {
  id: string;
  status: string;
  checkoutUrl: string | null;
  message: string | null;
}

export interface SasPayVerifiedTransaction {
  id: string;
  reference: string | null;
  externalReference: string | null;
  status: string;
  requestedAmountMinor: number | null;
  netAmountMinor: number | null;
  chargedAmountMinor: number | null;
  feeMinor: number | null;
  feeChargeMode: string | null;
  currency: string | null;
  country: string | null;
  network: string | null;
}

/** Erreur amont SasPay rejouable (réseau/timeout/5xx) : l'intention reste
 *  PENDING et la même Idempotency-Key sera réutilisée au retry. */
export class SasPayUpstreamException extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'SasPayUpstreamException';
  }
}

/** Erreur SasPay terminale (4xx métier : scope, routage, validation,
 *  conflit de clé) : l'intention passe FAILED, aucun retry identique. */
export class SasPayTerminalException extends Error {
  readonly retryable = false;
  readonly code: string | null;
  readonly httpStatus: number;
  constructor(message: string, code: string | null, httpStatus: number) {
    super(message);
    this.name = 'SasPayTerminalException';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Convertit un entier XAF en décimal string SasPay ("25000.00"). */
export function toSasPayDecimal(amountMinor: number): string {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Le montant doit être un entier strictement positif.');
  }
  return `${amountMinor}.00`;
}

/** Parse un décimal string SasPay en entier XAF. Le XAF n'a pas de
 *  sous-unité : "5000.00" → 5000 ; toute fraction non nulle ("12.50") est
 *  invalide et retourne null (jamais de troncature silencieuse). */
export function fromSasPayDecimal(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  if (match[2] !== undefined && Number(match[2]) !== 0) return null;
  const units = Number(match[1]);
  if (!Number.isSafeInteger(units) || units < 0) return null;
  return units;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

@Injectable()
export class SasPayApiClient {
  private readonly logger = new Logger(SasPayApiClient.name);

  constructor(private readonly config: SasPayConfig) {}

  private apiKeyOrThrow(): string {
    const key = this.config.apiKey;
    if (!key) {
      throw new SasPayTerminalException(
        'Paiement indisponible : clé API SasPay non configurée côté serveur.',
        'missing_api_key',
        503,
      );
    }
    return key;
  }

  private async request<T>(
    method: 'POST' | 'GET',
    path: string,
    body: Record<string, unknown> | null,
    idempotencyKey: string | null,
  ): Promise<{ httpStatus: number; payload: T }> {
    const key = this.apiKeyOrThrow();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(SASPAY_REQUEST_TIMEOUT_MS) };
      if (body) init.body = JSON.stringify(body);
      res = await fetch(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      throw new SasPayUpstreamException(
        `SasPay injoignable (${error instanceof Error ? error.message : 'réseau'}). Réessayez.`,
      );
    }
    let payload: T;
    try {
      payload = (await res.json()) as T;
    } catch {
      throw new SasPayUpstreamException(`Réponse SasPay illisible (HTTP ${res.status}). Réessayez.`);
    }
    return { httpStatus: res.status, payload };
  }

  /** Initie un pay-in softpay. 201/200 → résultat ; 409 clé rejouée avec un
   *  corps différent → terminal ; 4xx métier → terminal ; 5xx → rejouable. */
  async initializeSoftpay(input: SoftpayInitInput): Promise<SoftpayInitResult> {
    if (!input.idempotencyKey || input.idempotencyKey.length > SASPAY_IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new Error('Idempotency-Key invalide pour SasPay.');
    }
    const { httpStatus, payload } = await this.request<Record<string, unknown>>(
      'POST',
      '/payments/softpay/',
      {
        amount: toSasPayDecimal(input.amountMinor),
        currency: input.currency,
        country: input.country,
        network: input.network,
        description: input.description,
        customer: {
          email: input.customer.email,
          first_name: input.customer.first_name,
          last_name: input.customer.last_name,
          phone: input.customer.phone,
        },
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      },
      input.idempotencyKey,
    );
    // La réponse est plate ou enveloppée sous `data` selon les versions.
    const body = asRecord(payload);
    const data = asRecord(body?.data) ?? body ?? {};
    if (httpStatus === 409) {
      throw new SasPayTerminalException(
        asNonEmptyString(data.message) ?? 'Conflit idempotence SasPay : clé déjà utilisée avec un autre contenu.',
        'idempotency_conflict',
        409,
      );
    }
    if (httpStatus >= 500) {
      throw new SasPayUpstreamException(
        asNonEmptyString(data.message) ?? `SasPay en erreur (HTTP ${httpStatus}). Réessayez.`,
      );
    }
    if (httpStatus >= 400) {
      throw new SasPayTerminalException(
        asNonEmptyString(data.message) ?? `Paiement refusé par SasPay (HTTP ${httpStatus}).`,
        asNonEmptyString(data.code),
        httpStatus,
      );
    }
    const id = asNonEmptyString(data.id);
    if (!id) {
      throw new SasPayUpstreamException('Réponse SasPay incomplète (identifiant manquant). Réessayez.');
    }
    const checkoutUrl = asNonEmptyString(data.checkout_url);
    return {
      id,
      status: asNonEmptyString(data.status) ?? 'PENDING',
      checkoutUrl,
      message: asNonEmptyString(data.message),
    };
  }

  /** Revérifie un paiement côté gateway (statut PENDING reverifié côté
   *  SasPay, jamais de statut mémorisé). 404 → null (inconnu, on n'invente
   *  aucun échec). */
  async verifyPayment(paymentId: string): Promise<SasPayVerifiedTransaction | null> {
    const { httpStatus, payload } = await this.request<Record<string, unknown>>(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}/verify/`,
      null,
      null,
    );
    const body = asRecord(payload);
    const data = asRecord(body?.data) ?? body ?? {};
    if (httpStatus === 404) return null;
    if (httpStatus >= 500) {
      throw new SasPayUpstreamException(`Vérification SasPay en erreur (HTTP ${httpStatus}). Réessayez.`);
    }
    if (httpStatus >= 400) {
      throw new SasPayTerminalException(
        asNonEmptyString(data.message) ?? `Vérification refusée (HTTP ${httpStatus}).`,
        asNonEmptyString(data.code),
        httpStatus,
      );
    }
    return {
      id: asNonEmptyString(data.id) ?? paymentId,
      reference: asNonEmptyString(data.reference),
      externalReference: asNonEmptyString(data.external_reference),
      status: (asNonEmptyString(data.status) ?? 'PENDING').toUpperCase(),
      requestedAmountMinor: fromSasPayDecimal(data.requested_amount ?? data.amount),
      netAmountMinor: fromSasPayDecimal(data.net_amount),
      chargedAmountMinor: fromSasPayDecimal(data.charged ?? data.debited_amount),
      feeMinor:
        fromSasPayDecimal(data.client_fee) ??
        fromSasPayDecimal(data.gateway_fee) ??
        fromSasPayDecimal(data.fee),
      feeChargeMode: asNonEmptyString(data.fee_charge_mode),
      currency: asNonEmptyString(data.currency),
      country: asNonEmptyString(data.country),
      network: asNonEmptyString(data.network),
    };
  }
}
