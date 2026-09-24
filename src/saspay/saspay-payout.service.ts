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
  PAYOUT_USER_MESSAGES,
  classifyPayoutRejection,
  type PayoutPaymentError,
} from './saspay-errors.js';
import {
  SASPAY_PAYOUT_COUNTRY,
  asShortCode,
  isSupportedPayoutNetwork,
  normalizeMsisdn,
} from './saspay-networks.js';

/* Sprint PAYOUT — Orchestration retrait Relio ↔ SasPay (SasPayModule).
 *
 * REAL : init `POST /payouts/initialize/` systématique avec Idempotency-Key
 * = demande logique, puis confirmation UNIQUEMENT via webhook/vérification
 * serveur. Le débit ledger définitif (CLIENT_/TECHNICIAN_WITHDRAWAL) n'est
 * créé qu'au SUCCESS, au montant `charged` constaté (frais SasPay jamais
 * calculés par Relio). Timeout/réseau → PENDING conservé, même clé au retry,
 * jamais de FAILED automatique, jamais de second payout.
 * SIMULATION : intention PENDING + hold uniquement, aucun appel.
 * Aucun payout admin RelioWithdrawal ici (flux existant inchangé). */

export interface PayoutInitInput {
  network?: string | null;
  msisdn?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

@Injectable()
export class SasPayPayoutService {
  private readonly logger = new Logger(SasPayPayoutService.name);

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
        'Retrait réel indisponible : le mode financier serveur est SIMULATION.',
      );
    }
  }

  private ensureSasPayReady() {
    if (!this.saspayConfig.isConfigured()) {
      throw new ServiceUnavailableException(
        'Retrait indisponible : configuration SasPay incomplète côté serveur.',
      );
    }
    const mismatch = this.saspayConfig.keyModeMismatch();
    if (mismatch) {
      throw new ServiceUnavailableException(`Retrait indisponible : ${mismatch}.`);
    }
  }

  /** Initialise le payout SasPay d'une demande PENDING (REAL uniquement).
   *  Idempotent : demande déjà initialisée → résultat stocké renvoyé sans
   *  nouvel appel ; demande SUCCESS → retournée telle quelle. */
  async initializeWithdrawalPayout(actorUserId: string, requestReference: string, input: PayoutInitInput = {}) {
    this.ensureRealMode();
    this.ensureSasPayReady();

    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { reference: requestReference },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } } },
    });
    if (!request || request.userId !== actorUserId) {
      throw new NotFoundException('Demande de retrait introuvable.');
    }
    if (request.mode !== this.financial.getMode()) {
      throw new ForbiddenException('Demande dans un autre mode financier.');
    }
    if (request.status === 'SUCCESS') {
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      return { saspayEnabled: true as const, saspayTransactionId: request.saspayTransactionId, request: current, paymentError: null, note: 'Demande déjà confirmée (aucun nouvel appel).' };
    }
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        `Demande déjà traitée (statut « ${request.status} ») : créez une nouvelle demande de retrait.`,
      );
    }
    if (request.saspayTransactionId) {
      // Init déjà effectuée (retry) : on ne rappelle jamais SasPay pour la
      // même demande — la même Idempotency-Key couvrirait de toute façon le
      // rejouement côté prestataire.
      this.logger.warn(`Init payout déjà effectuée pour ${request.reference} : résultat stocké renvoyé.`);
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      return { saspayEnabled: true as const, saspayTransactionId: request.saspayTransactionId, request: current, paymentError: null, note: null };
    }

    const network = input.network ?? request.network;
    if (!isSupportedPayoutNetwork(network)) {
      throw new ConflictException(
        'Réseau manquant ou non supporté (mtn_cm, orange_cm). Reprenez la demande.',
      );
    }
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const rawMsisdn =
      input.msisdn ?? (typeof metadata.msisdn === 'string' ? metadata.msisdn : null);
    const msisdn = normalizeMsisdn(rawMsisdn);
    if (!msisdn) {
      throw new ConflictException('Numéro mobile money bénéficiaire manquant ou invalide. Reprenez la demande.');
    }
    const firstName = (input.firstName ?? request.user.firstName ?? '').trim() || 'Client';
    const lastName = (input.lastName ?? request.user.lastName ?? '').trim() || 'Relio';
    const email = (input.email ?? request.user.email ?? '').trim() || 'client@relio.local';

    const description = `Retrait Relio ${request.reference}`;
    try {
      const init = await this.api.initializePayout({
        amountMinor: request.amount,
        currency: request.currency,
        country: SASPAY_PAYOUT_COUNTRY,
        method: network,
        description,
        customer: { email, first_name: firstName, last_name: lastName, phone: msisdn },
        recipient: { msisdn },
        metadata: { withdrawalRequestReference: request.reference, userId: request.userId },
        idempotencyKey: request.idempotencyKey,
      });
      const updated = await this.prisma.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          saspayTransactionId: init.id,
          network,
          country: SASPAY_PAYOUT_COUNTRY,
          metadata: {
            ...(metadata as Record<string, unknown>),
            msisdn,
            saspayStatus: 'PENDING',
            saspayMessage: init.message,
          },
        },
      });
      void updated;
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      return { saspayEnabled: true as const, saspayTransactionId: init.id, request: current, paymentError: null, note: null };
    } catch (error) {
      if (error instanceof SasPayTerminalException) {
        const rejection = classifyPayoutRejection(error.httpStatus, error.code, error.message);
        this.logger.warn(
          `Init payout SasPay refusée pour ${request.reference} ` +
            `(HTTP ${error.httpStatus}, code ${error.code ?? '—'}) : ${error.message}`,
        );
        if (rejection.outcome === 'retryable') {
          // Transitoire : PENDING conservé, 503 explicite, retry avec la
          // même demande/clé.
          throw new ServiceUnavailableException({
            code: rejection.error.code,
            message: rejection.error.message,
          });
        }
        // Refus définitif, validation ou IP/config : demande FAILED (hold
        // libéré, aucun débit) + réponse 201 avec la demande à jour et la
        // raison sûre (référence connue pour le suivi).
        const failed = await this.financial.settleWithdrawalFailure(
          request.reference,
          'FAILED',
          `SASPAY_PAYOUT_INIT ${error.code ?? error.httpStatus} — ${error.message}`.slice(0, 500),
        );
        return {
          saspayEnabled: true as const,
          saspayTransactionId: null,
          request: failed,
          paymentError: rejection.error,
          note: null,
        };
      }
      if (error instanceof SasPayUpstreamException) {
        // Réseau/timeout/5xx sans refus métier : la demande RESTE PENDING
        // (SasPay a pu créer le payout — jamais de FAILED automatique, jamais
        // de second payout : même Idempotency-Key au retry).
        this.logger.warn(`Init payout SasPay rejouable pour ${request.reference} : ${error.message}`);
        const transient = error.httpStatus !== null || /injoignable|illisible|erreur \(HTTP/i.test(error.message);
        const code = transient ? 'PROVIDER_UNAVAILABLE' : 'COMMUNICATION_ERROR';
        throw new ServiceUnavailableException({
          code,
          message:
            code === 'PROVIDER_UNAVAILABLE'
              ? PAYOUT_USER_MESSAGES.PROVIDER_UNAVAILABLE
              : PAYOUT_USER_MESSAGES.COMMUNICATION_ERROR,
        });
      }
      throw error;
    }
  }

  /** Vérification serveur d'un payout (GET /payouts/{id}/verify/), sans
   *  polling : SUCCESS → débit unique au charged constaté ; FAILED/CANCELLED
   *  → hold libéré sans débit ; PENDING → attente ; 404 → inconnu.
   *  Erreur de communication → 200 structurée (`verificationError`),
   *  demande PENDING conservée, jamais de 500 générique. */
  async verifyWithdrawalPayout(actorUserId: string, requestReference: string) {
    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { reference: requestReference },
    });
    if (!request || request.userId !== actorUserId) {
      throw new NotFoundException('Demande de retrait introuvable.');
    }
    if (request.status === 'SUCCESS') {
      return { request: await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference), saspayStatus: 'SUCCESS' as const, verificationError: null };
    }
    if (!request.saspayTransactionId) {
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      return { request: current, saspayStatus: null, verificationError: null };
    }
    this.ensureSasPayReady();
    let verified;
    try {
      verified = await this.api.verifyPayout(request.saspayTransactionId);
    } catch (error) {
      this.logger.warn(
        `Vérification payout SasPay impossible pour ${request.reference} ` +
          `(${error instanceof Error ? error.message : 'erreur'}).`,
      );
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      if (error instanceof SasPayUpstreamException) {
        const transient =
          error.httpStatus !== null || /injoignable|illisible|erreur \(HTTP/i.test(error.message);
        const code = transient ? 'PROVIDER_UNAVAILABLE' : 'COMMUNICATION_ERROR';
        return {
          request: current,
          saspayStatus: 'UNKNOWN' as const,
          verificationError: {
            code,
            message:
              code === 'PROVIDER_UNAVAILABLE'
                ? PAYOUT_USER_MESSAGES.PROVIDER_UNAVAILABLE
                : PAYOUT_USER_MESSAGES.COMMUNICATION_ERROR,
          } as PayoutPaymentError,
        };
      }
      return {
        request: current,
        saspayStatus: 'UNKNOWN' as const,
        verificationError: {
          code: 'PROVIDER_UNAVAILABLE',
          message: PAYOUT_USER_MESSAGES.PROVIDER_UNAVAILABLE,
        } as PayoutPaymentError,
      };
    }
    if (!verified) {
      const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
      return {
        request: current,
        saspayStatus: 'UNKNOWN' as const,
        verificationError: {
          code: 'TRANSACTION_UNKNOWN',
          message: PAYOUT_USER_MESSAGES.TRANSACTION_UNKNOWN,
        } as PayoutPaymentError,
      };
    }
    const status = verified.status.toUpperCase();
    if (status === 'SUCCESS') {
      const result = await this.financial.settleWithdrawalSuccess(request.reference, {
        saspayTransactionId: verified.id,
        saspayReference: verified.reference,
        externalReference: verified.externalReference,
        network: asShortCode(verified.network),
        country: asShortCode(verified.country),
        fee: verified.feeMinor,
        chargedAmount: verified.chargedAmountMinor,
        netAmount: verified.netAmountMinor,
        feeChargeMode: verified.feeChargeMode,
      });
      return { request: result.request, saspayStatus: 'SUCCESS' as const, verificationError: null };
    }
    if (status === 'FAILED') {
      const failed = await this.financial.settleWithdrawalFailure(
        request.reference,
        'FAILED',
        'Vérification serveur : payout en échec.',
      );
      return { request: failed, saspayStatus: 'FAILED' as const, verificationError: null };
    }
    if (status === 'CANCELLED' || status === 'CANCELED') {
      const cancelled = await this.financial.settleWithdrawalFailure(request.reference, 'CANCELLED');
      return { request: cancelled, saspayStatus: 'CANCELLED' as const, verificationError: null };
    }
    if (verified.reference || verified.externalReference) {
      await this.prisma.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          saspayReference: verified.reference ?? request.saspayReference,
          externalReference: verified.externalReference ?? request.externalReference,
          fee: verified.feeMinor ?? request.fee,
          chargedAmount: verified.chargedAmountMinor ?? request.chargedAmount,
          netAmount: verified.netAmountMinor ?? request.netAmount,
        },
      });
    }
    const current = await this.financial.getWithdrawalRequestForOwner(actorUserId, requestReference);
    return { request: current, saspayStatus: status, verificationError: null };
  }
}
