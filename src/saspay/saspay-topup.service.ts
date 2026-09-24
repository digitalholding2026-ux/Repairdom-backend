import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { FinancialService } from '../financial/financial.service.js';
import { SasPayApiClient, SasPayTerminalException, SasPayUpstreamException } from './saspay-api.client.js';
import { SasPayConfig } from './saspay.config.js';
import {
  TOPUP_USER_MESSAGES,
  classifyInitRejection,
  type TopupPaymentError,
} from './saspay-errors.js';
import {
  SASPAY_TOPUP_COUNTRY,
  asShortCode,
  isSupportedTopupNetwork,
  normalizeMsisdn,
} from './saspay-networks.js';

/* Sprint SASPAY-03 — Orchestration pay-in Relio ↔ SasPay (SasPayModule).
 *
 * SIMULATION : aucune opération (l'intention reste PENDING, aucun appel).
 * REAL : init softpay systématique avec Idempotency-Key = intention, puis
 * confirmation UNIQUEMENT via webhook/verify serveur. Le retour navigateur
 * (return_url) ne prouve jamais rien : le frontend relit le statut Relio.
 * Aucun payout, aucun Payment Link, aucun appel catalogue répété. */

export interface TopupInitInput {
  network?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

@Injectable()
export class SasPayTopupService {
  private readonly logger = new Logger(SasPayTopupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: FinancialService,
    private readonly api: SasPayApiClient,
    private readonly saspayConfig: SasPayConfig,
    private readonly config: ConfigService,
  ) {}

  private ensureRealMode() {
    if (this.financial.getMode() !== 'REAL') {
      throw new ForbiddenException(
        'Paiement réel indisponible : le mode financier serveur est SIMULATION.',
      );
    }
  }

  private ensureSasPayReady() {
    if (!this.saspayConfig.isConfigured()) {
      throw new ServiceUnavailableException(
        'Paiement indisponible : configuration SasPay incomplète côté serveur.',
      );
    }
    const mismatch = this.saspayConfig.keyModeMismatch();
    if (mismatch) {
      throw new ServiceUnavailableException(`Paiement indisponible : ${mismatch}.`);
    }
  }

  private returnUrlFor(intentReference: string): string | null {
    const base = this.config.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '');
    if (!base) return null;
    return `${base}/client/solde/recharge/result?intent=${encodeURIComponent(intentReference)}`;
  }

  /** Initialise le paiement SasPay d'une intention PENDING (REAL uniquement).
   *  Idempotent : intention déjà initialisée → résultat stocké renvoyé sans
   *  nouvel appel ; intention SUCCESS → retournée telle quelle.
   *  Gestion d'erreur catégorisée (détail technique en logs + errorMessage,
   *  message sûr pour l'UI) :
   *  - indisponibilité transitoire (ex. Orange « momentanément injoignable »,
   *    5xx, 429, timeout) → 503, intention PENDING conservée, même
   *    Idempotency-Key au retry (jamais de FAILED automatique) ;
   *  - refus/validation → intention FAILED + `paymentError` renvoyé en 201
   *    (aucun crédit, aucun débit) ;
   *  - statut final non-PENDING renvoyé par l'init (FAILED/CANCELLED) →
   *    intention marquée aussitôt, jamais laissée PENDING à tort. */
  async initializeTopupPayment(actorUserId: string, intentReference: string, input: TopupInitInput = {}) {
    this.ensureRealMode();
    this.ensureSasPayReady();

    const intent = await this.prisma.topupIntent.findUnique({
      where: { reference: intentReference },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!intent || intent.userId !== actorUserId) {
      throw new NotFoundException('Intention de recharge introuvable.');
    }
    if (intent.mode !== this.financial.getMode()) {
      throw new ForbiddenException('Intention dans un autre mode financier.');
    }
    if (intent.status === 'SUCCESS') {
      const current = await this.financial.getTopupIntentForOwner(actorUserId, intent.reference);
      return {
        ...this.toInitResult(intent, 'Intention déjà confirmée (aucun nouvel appel).'),
        intent: current,
      };
    }
    if (intent.status !== 'PENDING') {
      throw new ConflictException(
        `Intention déjà traitée (statut « ${intent.status} ») : créez une nouvelle recharge.`,
      );
    }
    if (intent.saspayTransactionId) {
      // Initialisation déjà effectuée (retry) : on ne rappelle jamais SasPay
      // avec la même intention — la même Idempotency-Key couvrirait de toute
      // façon le rejouement côté prestataire.
      this.logger.warn(`Init déjà effectuée pour ${intent.reference} : résultat stocké renvoyé.`);
      const current = await this.financial.getTopupIntentForOwner(actorUserId, intent.reference);
      return { ...this.toInitResult(intent, null), intent: current };
    }

    const network = input.network ?? intent.network;
    if (!isSupportedTopupNetwork(network)) {
      throw new ConflictException(
        'Réseau manquant ou non supporté (mtn_cm, orange_cm). Reprenez la création.',
      );
    }
    const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
    const rawPhone =
      input.phone ?? (typeof metadata.phone === 'string' ? metadata.phone : null);
    const phone = normalizeMsisdn(rawPhone);
    if (!phone) {
      throw new ConflictException('Numéro de téléphone manquant ou invalide. Reprenez la création.');
    }
    const firstName =
      (input.firstName ?? intent.user.firstName ?? '').trim() || 'Client';
    const lastName = (input.lastName ?? intent.user.lastName ?? '').trim() || 'Relio';
    const email = (input.email ?? intent.user.email ?? '').trim() || 'client@relio.local';

    const description = `Recharge Relio ${intent.reference}`;
    try {
      const init = await this.api.initializeSoftpay({
        amountMinor: intent.amount,
        currency: intent.currency,
        country: SASPAY_TOPUP_COUNTRY,
        network,
        description,
        customer: { email, first_name: firstName, last_name: lastName, phone },
        metadata: { topupIntentReference: intent.reference, userId: intent.userId },
        returnUrl: this.returnUrlFor(intent.reference),
        idempotencyKey: intent.idempotencyKey,
      });
      const updated = await this.prisma.topupIntent.update({
        where: { id: intent.id },
        data: {
          saspayTransactionId: init.id,
          network,
          country: SASPAY_TOPUP_COUNTRY,
          metadata: {
            ...(metadata as Record<string, unknown>),
            phone,
            checkout_url: init.checkoutUrl,
            saspayStatus: init.status,
            saspayMessage: init.message,
          },
        },
      });
      // L'init peut répondre d'emblée un statut final (réseau en échec
      // immédiat) : on le répercute aussitôt au lieu de laisser PENDING.
      const initStatus = (init.status ?? '').toUpperCase();
      if (initStatus === 'FAILED') {
        const failed = await this.financial.failTopupIntent(
          intent.reference,
          `SASPAY_INIT — ${init.message ?? 'paiement refusé à l’initialisation'}`.slice(0, 500),
        );
        return {
          saspayEnabled: true as const,
          checkoutUrl: null,
          pushSent: false,
          saspayStatus: 'FAILED' as const,
          saspayTransactionId: init.id,
          note: null,
          intent: failed,
          paymentError: classifyInitRejection(200, null, init.message).error,
        };
      }
      if (initStatus === 'CANCELLED' || initStatus === 'CANCELED') {
        const cancelled = await this.financial.cancelTopupIntent(intent.reference);
        return {
          saspayEnabled: true as const,
          checkoutUrl: null,
          pushSent: false,
          saspayStatus: 'CANCELLED' as const,
          saspayTransactionId: init.id,
          note: null,
          intent: cancelled,
          paymentError: { code: 'PAYMENT_FAILED', message: TOPUP_USER_MESSAGES.PAYMENT_FAILED } as TopupPaymentError,
        };
      }
      return {
        ...this.toInitResult(updated, null),
        intent: await this.financial.getTopupIntentForOwner(actorUserId, intent.reference),
        paymentError: null,
      };
    } catch (error) {
      if (error instanceof SasPayTerminalException) {
        const rejection = classifyInitRejection(error.httpStatus, error.code, error.message);
        this.logger.warn(
          `Init SasPay refusée pour ${intent.reference} ` +
            `(HTTP ${error.httpStatus}, code ${error.code ?? '—'}) : ${error.message}`,
        );
        if (rejection.outcome === 'retryable') {
          // Transitoire (ex. Orange momentanément injoignable) : PENDING
          // conservé, 503 explicite, retry avec la même intention/clé.
          throw new ServiceUnavailableException({
            code: rejection.error.code,
            message: rejection.error.message,
          });
        }
        // Refus définitif ou validation : intention FAILED, aucun crédit,
        // aucun débit — mais réponse 201 avec l'intention et la raison sûre
        // (le frontend n'a pas à deviner, et connaît la référence pour le suivi).
        const failed = await this.financial.failTopupIntent(
          intent.reference,
          `SASPAY_INIT ${error.code ?? error.httpStatus} — ${error.message}`.slice(0, 500),
        );
        return {
          saspayEnabled: true as const,
          checkoutUrl: null,
          pushSent: false,
          saspayStatus: 'FAILED' as const,
          saspayTransactionId: null,
          note: null,
          intent: failed,
          paymentError: rejection.error,
        };
      }
      if (error instanceof SasPayUpstreamException) {
        // Réseau/timeout/5xx sans refus métier : l'intention RESTE PENDING
        // (SasPay a pu recevoir la transaction — jamais de FAILED
        // automatique), la même Idempotency-Key sera réutilisée au retry.
        this.logger.warn(`Init SasPay rejouable pour ${intent.reference} : ${error.message}`);
        const transient = error.httpStatus !== null || /injoignable|illisible|erreur \(HTTP/i.test(error.message);
        const code = transient ? 'PROVIDER_UNAVAILABLE' : 'COMMUNICATION_ERROR';
        throw new ServiceUnavailableException({
          code,
          message:
            code === 'PROVIDER_UNAVAILABLE'
              ? TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE
              : TOPUP_USER_MESSAGES.COMMUNICATION_ERROR,
        });
      }
      throw error;
    }
  }

  /** Vérification serveur d'un paiement (GET /payments/{id}/verify/), sans
   *  polling : applique les mêmes transitions idempotentes que le webhook
   *  (SUCCESS → crédit unique ; FAILED/CANCELLED → marquage ; PENDING →
   *  attente ; 404 → inconnu, on n'invente rien).
   *  Les erreurs de communication SasPay ne remontent jamais en 500
   *  générique : réponse 200 avec `verificationError` (code + message sûr),
   *  l'intention restant PENDING pour re-vérification. */
  async verifyTopupPayment(actorUserId: string, intentReference: string) {
    const intent = await this.prisma.topupIntent.findUnique({
      where: { reference: intentReference },
    });
    if (!intent || intent.userId !== actorUserId) {
      throw new NotFoundException('Intention de recharge introuvable.');
    }
    if (intent.status === 'SUCCESS') {
      return { intent: await this.financial.getTopupIntentForOwner(actorUserId, intentReference), saspayStatus: 'SUCCESS' as const, verificationError: null };
    }
    if (!intent.saspayTransactionId) {
      const current = await this.financial.getTopupIntentForOwner(actorUserId, intentReference);
      return { intent: current, saspayStatus: null, verificationError: null };
    }
    this.ensureSasPayReady();
    let verified;
    try {
      verified = await this.api.verifyPayment(intent.saspayTransactionId);
    } catch (error) {
      // Jamais de 500 générique vers l'UI : état structuré + intention
      // PENDING conservée pour re-vérification. Détail technique en logs.
      this.logger.warn(
        `Vérification SasPay impossible pour ${intent.reference} ` +
          `(${error instanceof Error ? error.message : 'erreur'}).`,
      );
      const current = await this.financial.getTopupIntentForOwner(actorUserId, intentReference);
      if (error instanceof SasPayUpstreamException) {
        const transient =
          error.httpStatus !== null || /injoignable|illisible|erreur \(HTTP/i.test(error.message);
        const code = transient ? 'PROVIDER_UNAVAILABLE' : 'COMMUNICATION_ERROR';
        return {
          intent: current,
          saspayStatus: 'UNKNOWN' as const,
          verificationError: {
            code,
            message:
              code === 'PROVIDER_UNAVAILABLE'
                ? TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE
                : TOPUP_USER_MESSAGES.COMMUNICATION_ERROR,
          } as TopupPaymentError,
        };
      }
      return {
        intent: current,
        saspayStatus: 'UNKNOWN' as const,
        verificationError: {
          code: 'PROVIDER_UNAVAILABLE',
          message: TOPUP_USER_MESSAGES.PROVIDER_UNAVAILABLE,
        } as TopupPaymentError,
      };
    }
    if (!verified) {
      const current = await this.financial.getTopupIntentForOwner(actorUserId, intentReference);
      return {
        intent: current,
        saspayStatus: 'UNKNOWN' as const,
        verificationError: {
          code: 'TRANSACTION_UNKNOWN',
          message: TOPUP_USER_MESSAGES.TRANSACTION_UNKNOWN,
        } as TopupPaymentError,
      };
    }
    const status = verified.status.toUpperCase();
    if (status === 'SUCCESS') {
      const result = await this.financial.confirmTopupFromSasPay({
        intentReference: intent.reference,
        saspayTransactionId: verified.id,
        currency: verified.currency,
        requestedAmountMinor: verified.requestedAmountMinor,
        netAmountMinor: verified.netAmountMinor,
        chargedAmountMinor: verified.chargedAmountMinor,
        feeMinor: verified.feeMinor,
        feeChargeMode: verified.feeChargeMode,
        saspayReference: verified.reference,
        externalReference: verified.externalReference,
        network: asShortCode(verified.network),
        country: asShortCode(verified.country),
      });
      return { intent: result.intent, saspayStatus: 'SUCCESS' as const, verificationError: null };
    }
    if (status === 'FAILED') {
      const failed = await this.financial.failTopupIntent(
        intent.reference,
        'Vérification serveur : paiement en échec.',
      );
      return { intent: failed, saspayStatus: 'FAILED' as const, verificationError: null };
    }
    if (status === 'CANCELLED' || status === 'CANCELED') {
      const cancelled = await this.financial.cancelTopupIntent(intent.reference);
      return { intent: cancelled, saspayStatus: 'CANCELLED' as const, verificationError: null };
    }
    // PENDING (ou autre) : on enregistre les références connues, sans effet.
    if (verified.reference || verified.externalReference) {
      await this.prisma.topupIntent.update({
        where: { id: intent.id },
        data: {
          saspayReference: verified.reference ?? intent.saspayReference,
          externalReference: verified.externalReference ?? intent.externalReference,
        },
      });
    }
    const current = await this.financial.getTopupIntentForOwner(actorUserId, intentReference);
    return { intent: current, saspayStatus: status, verificationError: null };
  }

  private toInitResult(
    intent: {
      reference: string;
      status: string;
      metadata: unknown;
      saspayTransactionId: string | null;
    },
    note: string | null,
  ) {
    const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
    const checkoutUrl =
      typeof metadata.checkout_url === 'string' && metadata.checkout_url
        ? metadata.checkout_url
        : null;
    return {
      saspayEnabled: true as const,
      checkoutUrl,
      pushSent: checkoutUrl === null,
      saspayStatus:
        typeof metadata.saspayStatus === 'string' ? metadata.saspayStatus : 'PENDING',
      saspayTransactionId: intent.saspayTransactionId,
      note,
      paymentError: null,
    };
  }
}
