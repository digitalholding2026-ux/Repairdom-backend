import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FinancialService } from '../financial/financial.service.js';
import { SasPayConfig } from './saspay.config.js';

/** Fenêtre d'acceptation du timestamp webhook (5 minutes). */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Événements transactionnels traités en v1. Les payloads `settlement.*`
 *  sont explicitement ignorés : SasPay indique que leur structure `data`
 *  n'est pas encore stable — le cœur métier n'en dépend jamais. */
const HANDLED_TRANSACTION_EVENTS = new Set(['transaction.success', 'transaction.failed']);

export interface WebhookSaspayRefs {
  saspayTransactionId?: string | null;
  saspayReference?: string | null;
  externalReference?: string | null;
  network?: string | null;
  country?: string | null;
  fee?: number | null;
  chargedAmount?: number | null;
  netAmount?: number | null;
}

/**
 * Fondation webhook SasPay (Sprint SASPAY-01) : vérification HMAC +
 * dispatch idempotent. Contraintes :
 *  - signature HMAC-SHA256(timestamp + "." + rawBody exact), comparaison
 *    constante, timestamp ≤ 5 minutes, secret backend uniquement ;
 *  - aucune confiance dans le frontend : seul ce traitement serveur peut
 *    créditer le ledger (via FinancialService, idempotent) ;
 *  - réponse rapide, jamais de double écriture (rejouabilité sûre).
 */
@Injectable()
export class SasPayWebhookService {
  private readonly logger = new Logger(SasPayWebhookService.name);

  constructor(
    private readonly saspayConfig: SasPayConfig,
    private readonly financial: FinancialService,
  ) {}

  /** Vérifie l'authenticité d'un appel webhook. Lève 401 si invalide. */
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
   *  `FinancialService.confirmTopupIntent` + `reference` UNIQUE). */
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
    const internalReference =
      typeof data.internalReference === 'string' && data.internalReference.trim()
        ? data.internalReference.trim()
        : typeof data.externalReference === 'string' && data.externalReference.trim()
          ? data.externalReference.trim()
          : null;
    if (!internalReference) {
      this.logger.warn(
        `Événement SasPay « ${event} » sans référence interne : ignoré sans effet.`,
      );
      return { handled: false as const, reason: 'missing-reference' };
    }
    if (normalizedEvent === 'transaction.success') {
      const result = await this.financial.confirmTopupIntent(internalReference, refs);
      return { handled: true as const, event: normalizedEvent, credited: result.credited };
    }
    const failed = await this.financial.failTopupIntent(
      internalReference,
      typeof data.reason === 'string' ? data.reason : 'Paiement SasPay en échec.',
    );
    return { handled: true as const, event: normalizedEvent, status: failed.status };
  }
}

/** Extrait les références/montants SasPay d'un payload `data` (plates ou
 *  imbriqués), sans jamais faire confiance à un montant isolé : le net
 *  constaté fait foi côté confirmation. */
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
  const pickInt = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = data[key];
      if (Number.isInteger(value) && (value as number) >= 0) return value as number;
    }
    return null;
  };
  return {
    saspayTransactionId: pickString('saspayTransactionId', 'transactionId', 'id'),
    saspayReference: pickString('saspayReference', 'reference'),
    externalReference: pickString('externalReference', 'internalReference'),
    network: pickString('network'),
    country: pickString('country'),
    fee: pickInt('fee'),
    chargedAmount: pickInt('chargedAmount', 'charged'),
    netAmount: pickInt('netAmount', 'net', 'amount'),
  };
}
