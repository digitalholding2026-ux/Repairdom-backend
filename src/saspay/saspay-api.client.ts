import { Injectable, Logger } from '@nestjs/common';
import { SasPayConfig } from './saspay.config.js';

/* Sprint SASPAY-03 — Client HTTP SasPay minimal (pay-in uniquement).
 * Sprint PAYOUT — + payout (POST /payouts/initialize/, GET /payouts/{id}/verify/).
 *
 * Endpoints utilisés (doc https://docs.saspay.me, base
 * https://api.saspay.me/api/v1, Bearer sk_...) :
 *   POST /payments/softpay/         — init push/checkout (Idempotency-Key)
 *   GET  /payments/{id}/verify/     — revérification serveur (pas de polling)
 *   POST /payouts/initialize/       — init retrait (Idempotency-Key, scope
 *                                     PAYOUT/BOTH, IP whitelistée requise)
 *   GET  /payouts/{id}/verify/      — revérification retrait
 * Payment Links et checkout-sessions : HORS PÉRIMÈTRE.
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
  transactionType: string | null;
  flowDirection: string | null;
}

export interface PayoutRecipient {
  msisdn: string;
}

export interface PayoutInitInput {
  amountMinor: number;
  currency: string;
  country: string;
  method: string;
  description: string;
  customer: SoftpayCustomer;
  recipient: PayoutRecipient;
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface PayoutInitResult {
  id: string;
  message: string | null;
}

/** Erreur amont SasPay rejouable (réseau/timeout/5xx) : l'intention reste
 *  PENDING et la même Idempotency-Key sera réutilisée au retry. */
export class SasPayUpstreamException extends Error {
  readonly retryable = true;
  readonly httpStatus: number | null;
  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'SasPayUpstreamException';
    this.httpStatus = httpStatus;
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

/* ── DIAGNOSTIC TEMPORAIRE 403 payout (à supprimer après recette) ──
 * But : conserver/logguer le body exact SasPay lors d'un HTTP 403 sur
 * `POST /payouts/initialize/`, car le parsing actuel (`message`/`code`
 * uniquement) a produit `code — : Retrait refusé par SasPay (HTTP 403).`
 * Instrumentation LOG-ONLY : aucun changement de logique métier, statuts,
 * idempotence, endpoints ou frontend. Ne jamais logger `Authorization`,
 * clé API, webhook secret ni autre secret (redaction + troncature). */
const PAYOUT_403_DIAG_MAX_LENGTH = 1000;
const SENSITIVE_KEY_PATTERN = /api[_-]?key|secret|authorization|bearer|token|password|passwd/i;
const SENSITIVE_VALUE_PATTERN = /sk_(live|test)_[A-Za-z0-9]+/g;

function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_VALUE_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSensitive(entry);
    }
    return out;
  }
  return value;
}

function safeBodySnapshot(payload: unknown, maxLength = PAYOUT_403_DIAG_MAX_LENGTH): string {
  try {
    const raw = JSON.stringify(redactSensitive(payload)) ?? 'null';
    return raw.length > maxLength ? `${raw.slice(0, maxLength)}…[TRONQUE]` : raw;
  } catch {
    return '[BODY_NON_SERIALISABLE]';
  }
}

function diagFieldToString(value: unknown): string | null {
  if (typeof value === 'string') {
    const clean = value.trim();
    return clean ? clean.slice(0, 300) : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    return safeBodySnapshot(value, 500);
  }
  return null;
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

  /* POST vers le relay payout VPS (sortie IP fixe). Même body et même
   * Idempotency-Key que l'appel direct, header X-Relio-Relay-Secret, et
   * SURTOUT aucune clé SasPay (ni Authorization) : elle vit sur le VPS.
   * Le relay propage statut + JSON SasPay, interprétés à l'identique
   * ci-dessous. Secret jamais journalisé. */
  private async requestViaRelay<T>(
    body: Record<string, unknown>,
    idempotencyKey: string,
    relayUrl: string,
  ): Promise<{ httpStatus: number; payload: T }> {
    const relaySecret = this.config.payoutRelaySecret;
    if (!relaySecret) {
      throw new SasPayTerminalException(
        'Retrait indisponible : relais payout non configuré côté serveur.',
        'relay_misconfigured',
        503,
      );
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Relio-Relay-Secret': relaySecret,
      'Idempotency-Key': idempotencyKey,
    };
    let res: Response;
    try {
      res = await fetch(relayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SASPAY_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SasPayUpstreamException(
        `Relais payout injoignable (${error instanceof Error ? error.message : 'réseau'}). Réessayez.`,
      );
    }
    let payload: T;
    try {
      payload = (await res.json()) as T;
    } catch {
      throw new SasPayUpstreamException(`Réponse du relais illisible (HTTP ${res.status}). Réessayez.`);
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
        httpStatus,
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
      throw new SasPayUpstreamException(
        asNonEmptyString(data.message) ?? `Vérification SasPay en erreur (HTTP ${httpStatus}). Réessayez.`,
        httpStatus,
      );
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
      transactionType: asNonEmptyString(data.transaction_type),
      flowDirection: asNonEmptyString(data.flow_direction),
    };
  }

  /** Initie un payout (retrait). 201 → identifiant ; 403 (dont
   *  `ip_not_whitelisted` si aucune IP whitelistée) et 422 métier →
   *  terminal ; 409 clé rejouée → terminal ; 5xx → rejouable. La réponse
   *  201 ne contient que `{message, id}` : montants/frais exacts connus
   *  plus tard via verify/webhook (jamais calculés par Relio).
   *
   *  Si `SASPAY_PAYOUT_RELAY_URL` est configurée, l'init transite par le
   *  relay VPS (sortie IP fixe) : même body, même Idempotency-Key, header
   *  X-Relio-Relay-Secret, SANS clé SasPay. Réponse interprétée à
   *  l'identique (le relay propage statut + JSON SasPay). */
  async initializePayout(input: PayoutInitInput): Promise<PayoutInitResult> {
    if (!input.idempotencyKey || input.idempotencyKey.length > SASPAY_IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new Error('Idempotency-Key invalide pour SasPay.');
    }
    const payoutBody = {
      amount: toSasPayDecimal(input.amountMinor),
      currency: input.currency,
      country: input.country,
      method: input.method,
      description: input.description,
      customer: {
        email: input.customer.email,
        first_name: input.customer.first_name,
        last_name: input.customer.last_name,
        phone: input.customer.phone,
      },
      recipient: { msisdn: input.recipient.msisdn },
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const relayUrl = this.config.payoutRelayUrl;
    const { httpStatus, payload } =
      relayUrl
        ? await this.requestViaRelay(payoutBody, input.idempotencyKey, relayUrl)
        : await this.request<Record<string, unknown>>(
            'POST',
            '/payouts/initialize/',
            payoutBody,
            input.idempotencyKey,
          );
    const body = asRecord(payload);
    const data = asRecord(body?.data) ?? body ?? {};
    // DIAGNOSTIC TEMPORAIRE 403 (log-only, à supprimer après recette) : le
    // 403 observé en production n'avait ni `message` ni `code` exploitables
    // (`code —`), donc la raison SasPay exacte était perdue. On journalise
    // ici le body redacted/tronqué + champs utiles, SANS toucher à
    // l'exception levée ci-dessous (comportement FAILED/hold inchangé) et
    // SANS logger headers/secrets. `idempotencyKey` (UUID) et la référence
    // WD (déjà loggée côté service) ne sont pas des secrets.
    if (httpStatus === 403) {
      const pick = (key: string): string | null =>
        diagFieldToString(data[key]) ?? diagFieldToString(body?.[key]);
      const diagMetadata =
        input.metadata && typeof input.metadata === 'object'
          ? (input.metadata as Record<string, string>)
          : null;
      this.logger.warn(
        `[DIAG PAYOUT 403 TEMPORAIRE] HTTP 403 sur POST /payouts/initialize/ ` +
          `(idempotencyKey=${input.idempotencyKey}, ` +
          `withdrawalRef=${diagMetadata?.withdrawalRequestReference ?? '—'}) : ` +
          `code=${pick('code') ?? '—'} | message=${pick('message') ?? '—'} | ` +
          `detail=${pick('detail') ?? pick('details') ?? '—'} | ` +
          `error=${pick('error') ?? '—'} | errors=${pick('errors') ?? '—'} | ` +
          `reason=${pick('reason') ?? pick('error_code') ?? pick('errorCode') ?? '—'} | ` +
          `status=${pick('status') ?? '—'} | type=${pick('type') ?? '—'} | ` +
          `raw=${safeBodySnapshot(payload)}`,
      );
    }
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
        httpStatus,
      );
    }
    if (httpStatus >= 400) {
      throw new SasPayTerminalException(
        asNonEmptyString(data.message) ?? `Retrait refusé par SasPay (HTTP ${httpStatus}).`,
        asNonEmptyString(data.code),
        httpStatus,
      );
    }
    const id = asNonEmptyString(data.id);
    if (!id) {
      throw new SasPayUpstreamException('Réponse SasPay incomplète (identifiant manquant). Réessayez.');
    }
    return { id, message: asNonEmptyString(data.message) };
  }

  /** Revérifie un payout côté gateway (PENDING reverifié, jamais mémorisé).
   *  404 → null (inconnu, on n'invente aucun échec). */
  async verifyPayout(payoutId: string): Promise<SasPayVerifiedTransaction | null> {
    const { httpStatus, payload } = await this.request<Record<string, unknown>>(
      'GET',
      `/payouts/${encodeURIComponent(payoutId)}/verify/`,
      null,
      null,
    );
    const body = asRecord(payload);
    const data = asRecord(body?.data) ?? body ?? {};
    if (httpStatus === 404) return null;
    if (httpStatus >= 500) {
      throw new SasPayUpstreamException(
        asNonEmptyString(data.message) ?? `Vérification SasPay en erreur (HTTP ${httpStatus}). Réessayez.`,
        httpStatus,
      );
    }
    if (httpStatus >= 400) {
      throw new SasPayTerminalException(
        asNonEmptyString(data.message) ?? `Vérification refusée (HTTP ${httpStatus}).`,
        asNonEmptyString(data.code),
        httpStatus,
      );
    }
    return {
      id: asNonEmptyString(data.id) ?? payoutId,
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
      transactionType: asNonEmptyString(data.transaction_type),
      flowDirection: asNonEmptyString(data.flow_direction),
    };
  }
}
