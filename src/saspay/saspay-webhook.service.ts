import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FinancialService } from '../financial/financial.service.js';
import { SasPayConfig } from './saspay.config.js';
import { fromSasPayDecimal } from './saspay-api.client.js';
import { asShortCode } from './saspay-networks.js';

/** Fenêtre d'acceptation du timestamp webhook (5 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Événements transactionnels traités en v1. Les payloads `settlement.*`
 *  sont explicitement ignorés : SasPay indique que leur structure `data`
 *  n'est pas encore stable — le cœur métier n'en dépend jamais. */
const HANDLED_TRANSACTION_EVENTS = new Set([
  'transaction.success',
  'transaction.failed',
  'transaction.cancelled',
]);

export interface WebhookSaspayRefs {
  saspayTransactionId?: string | null;
  saspayReference?: string | null;
  externalReference?: string | null;
  internalReference?: string | null;
  network?: string | null;
  country?: string | null;
  msisdn?: string | null;
  currency?: string | null;
  status?: string | null;
  requestedAmountMinor?: number | null;
  feeMinor?: number | null;
  chargedAmountMinor?: number | null;
  netAmountMinor?: number | null;
  feeChargeMode?: string | null;
}

/**
 * Fondation webhook SasPay (Sprint SASPAY-01, durcie SASPAY-03) :
 * vérification HMAC sur le corps brut EXACT + dispatch idempotent.
 * Contraintes :
 *  - signature HMAC-SHA256(timestamp + "." + rawBody exact), comparaison
 *    constante, timestamp ≤ 5 minutes, secret backend uniquement ;
 *  - le JSON n'est parsé qu'APRÈS validation (le contrôleur exige req.rawBody,
 *    aucun fallback re-sérialisé) ;
 *  - aucune confiance dans le frontend : seul ce traitement serveur peut
 *    créditer le ledger (via FinancialService, idempotent) ;
 *  - contrôles montant/devise avant crédit (le net constaté fait foi,
 *    jamais `amount` seul) ; SUCCESS terminal jamais muté ;
 *  - réponse rapide, jamais de double écriture (rejouabilité sûre).
 */
@Injectable()
export class SasPayWebhookService {
  private readonly logger = new Logger(SasPayWebhookService.name);

  constructor(
    private readonly saspayConfig: SasPayConfig,
    private readonly financial: FinancialService,
  ) {}

  /** Vérifie l'authenticité d'un appel webhook sur le corps brut exact.
   *  Lève 401/403 si invalide. `rawBody` DOIT être les octets reçus. */
  verifySignature(
    rawBody: string | Buffer,
    timestampHeader: string | null | undefined,
    signatureHeader: string | null | undefined,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): void {
    const secret = this.saspayConfig.webhookSecret;
    if (!secret) {
      throw new UnauthorizedException('Webhooks SasPay non configurés.');
    }
    const timestamp = (timestampHeader ?? '').trim();
    const signature = (signatureHeader ?? '').trim().toLowerCase();
    if (!timestamp || !signature) {
      throw new UnauthorizedException('Signature webhook manquante.');
    }
    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      throw new UnauthorizedException('Timestamp webhook invalide.');
    }
    if (Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
      throw new UnauthorizedException('Timestamp webhook expiré.');
    }
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const received = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected.toLowerCase(), 'utf8');
    if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
      throw new UnauthorizedException('Signature webhook invalide.');
    }
  }

  /** Traite un événement déjà authentifié. Toujours idempotent : un même
   *  `transaction.success` rejoué ne crédite jamais deux fois (garde-fou
   *  `FinancialService.confirmTopupFromSasPay` + `reference` UNIQUE).
   *  Les contrôles montant/devise y sont appliqués avant tout crédit. */
  async handleEvent(event: string, data: Record<string, unknown>) {
    const normalizedEvent = event.trim().toLowerCase();
    if (normalizedEvent.startsWith('settlement.')) {
      this.logger.warn(
        `Événement SasPay « ${event} » ignoré : structure settlement.* instable (aucun effet ledger).`,
      );
      return { handled: false as const, reason: 'settlement-ignored' };
    }
    if (!HANDLED_TRANSACTION_EVENTS.has(normalizedEvent)) {
      this.logger.warn(`Événement SasPay inconnu « ${event} » : ignoré sans effet.`);
      return { handled: false as const, reason: 'unknown-event' };
    }
    const refs = extractSaspayRefs(data);
    const internalReference = refs.internalReference;
    if (!refs.saspayTransactionId && !internalReference) {
      this.logger.warn(`Événement SasPay « ${event} » sans référence : ignoré sans effet.`);
      return { handled: false as const, reason: 'missing-reference' };
    }

    if (normalizedEvent === 'transaction.success') {
      try {
        const result = await this.financial.confirmTopupFromSasPay({
          intentReference: internalReference,
          saspayTransactionId: refs.saspayTransactionId,
          currency: refs.currency,
          requestedAmountMinor: refs.requestedAmountMinor,
          netAmountMinor: refs.netAmountMinor,
          chargedAmountMinor: refs.chargedAmountMinor,
          feeMinor: refs.feeMinor,
          feeChargeMode: refs.feeChargeMode,
          saspayReference: refs.saspayReference,
          externalReference: refs.externalReference,
          network: refs.network,
          country: refs.country,
        });
        return { handled: true as const, event: normalizedEvent, credited: result.credited };
      } catch (error) {
        // Contrôle comptable refusé (devise/montant) ou transaction inconnue :
        // accusé de réception sans crédit, cause journalisée.
        this.logger.warn(
          `transaction.success non crédité (${error instanceof Error ? error.message : 'erreur'}).`,
        );
        return {
          handled: false as const,
          reason: 'rejected',
          message: error instanceof Error ? error.message : 'rejet',
        };
      }
    }

    const failureReason =
      typeof data.reason === 'string' && data.reason.trim()
        ? data.reason.trim()
        : normalizedEvent === 'transaction.cancelled'
          ? 'Paiement SasPay annulé.'
          : 'Paiement SasPay en échec.';
    try {
      if (normalizedEvent === 'transaction.cancelled') {
        await this.financial.cancelTopupFromSasPay({
          intentReference: internalReference,
          saspayTransactionId: refs.saspayTransactionId,
        });
      } else {
        await this.financial.failTopupFromSasPay({
          intentReference: internalReference,
          saspayTransactionId: refs.saspayTransactionId,
          reason: failureReason,
        });
      }
      return { handled: true as const, event: normalizedEvent };
    } catch (error) {
      this.logger.warn(
        `Événement « ${normalizedEvent} » non rattaché (${error instanceof Error ? error.message : 'erreur'}).`,
      );
      return {
        handled: false as const,
        reason: 'unknown-transaction',
        message: error instanceof Error ? error.message : 'rejet',
      };
    }
  }
}

/** Extrait les références/montants SasPay d'un payload `data` (format
 *  doc : décimaux en string ; tolère les entiers historiques).
 *  Les montants sont convertis en entiers minor ; le net constaté fait foi
 *  côté confirmation, jamais `amount` seul. */
export function extractSaspayRefs(data: Record<string, unknown>): WebhookSaspayRefs {
  const pickString = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    const nested = data.transaction;
    if (nested && typeof nested === 'object') {
      const record = nested as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return null;
  };
  const pickMinor = (...keys: string[]): number | null => {
    for (const key of keys) {
      const parsed = fromSasPayDecimal(data[key]);
      if (parsed !== null) return parsed;
      const value = data[key];
      if (Number.isInteger(value) && (value as number) >= 0) return value as number;
    }
    return null;
  };
  return {
    saspayTransactionId: pickString('saspayTransactionId', 'transactionId', 'id'),
    saspayReference: pickString('saspayReference', 'reference'),
    externalReference: pickString('externalReference', 'external_reference'),
    internalReference: pickString('internalReference', 'internal_reference'),
    network: asShortCode(pickString('network')),
    country: asShortCode(pickString('country')),
    msisdn: pickString('msisdn'),
    currency: pickString('currency'),
    status: pickString('status'),
    requestedAmountMinor: pickMinor('requested_amount', 'requestedAmount', 'amount'),
    feeMinor: pickMinor('fee', 'client_fee', 'gateway_fee', 'platform_fee'),
    chargedAmountMinor: pickMinor('charged', 'chargedAmount', 'debited_amount'),
    netAmountMinor: pickMinor('net_amount', 'netAmount', 'net'),
    feeChargeMode: pickString('fee_charge_mode', 'feeChargeMode'),
  };
}
