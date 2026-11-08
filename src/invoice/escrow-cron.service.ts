import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import {
  FinancialTransactionDirection,
  FinancialTransactionMode,
  FinancialTransactionStatus,
  FinancialTransactionType,
  FundsHoldStatus,
} from '../generated/prisma/enums.js';
import { isEscrowOverdue, ESCROW_REFUND_HOURS } from './invoice.service.js';

const logger = new Logger('EscrowCronService');

/** Vérifie toutes les heures les escrow arrivés à échéance (48h). */
@Injectable()
export class EscrowCronService implements OnModuleInit, OnModuleDestroy {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Première passe immédiatement, puis toutes les heures.
    void this.processOverdueEscrows();
    this.intervalId = setInterval(() => {
      void this.processOverdueEscrows();
    }, 60 * 60 * 1000);
    logger.log(`Service d'escrow démarré (vérification toutes les 60 min, seuil ${ESCROW_REFUND_HOURS}h).`);
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Cycle de remboursement automatique des escrow expirés. */
  async processOverdueEscrows() {
    const now = new Date();

    const holds = await this.prisma.fundsHold.findMany({
      where: {
        status: FundsHoldStatus.ACTIVE,
        demandeId: { not: null },
      },
      include: {
        demande: {
          include: {
            client: { select: { id: true, firstName: true, lastName: true, phone: true } },
          },
        },
      },
    });

    for (const hold of holds) {
      const demande = hold.demande;
      if (!demande || !demande.escrowStartedAt) continue;
      if (!isEscrowOverdue({ holdStartedAt: demande.escrowStartedAt, now })) continue;
      if (demande.status === 'COMPLETED') continue;

      await this.refundExpiredEscrow(hold, demande, now);
    }
  }

  private async refundExpiredEscrow(
    hold: any,
    demande: any,
    now: Date,
  ) {
    const client = demande.client;
    const amount = Number(hold.amount);

    // 1. Libère le hold.
    await this.prisma.fundsHold.update({
      where: { id: hold.id },
      data: { status: FundsHoldStatus.RELEASED, releasedAt: now },
    });

    // 2. Crédite le client (écriture ledger CREDIT).
    await this.prisma.financialTransaction.create({
      data: {
        userId: client.id,
        demandeId: demande.id,
        type: FinancialTransactionType.CLIENT_MISSION_DEBIT,
        direction: FinancialTransactionDirection.CREDIT,
        amount,
        currency: 'XAF',
        mode: FinancialTransactionMode.SIMULATION,
        status: FinancialTransactionStatus.VALIDATED,
        reference: `REFUND-${demande.reference ?? demande.id.slice(-6)}-${Date.now()}`,
        metadata: {
          reason: 'escrow-refund-48h',
          demandeReference: demande.reference,
          holdId: hold.id,
        },
        createdById: null,
      },
    });

    // 3. La demande reste en statut actuel (le hold est libéré, les fonds
    //    crédités) ; aucune facture n'est générée en cas de remboursement.

    // 4. Notification client (best-effort).
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (apiKey && client.phone) {
      const from =
        this.config.get<string>('EMAIL_FROM') ??
        this.config.get<string>('SMTP_FROM') ??
        'Relio <onboarding@resend.dev>';
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [client.phone],
            subject: `Remboursement escrow — demande ${demande.reference}`,
            text: `Votre demande ${demande.reference} n'a pas été terminée sous 48h. Les fonds (${amount} FCFA) ont été remboursés.`,
            html: `<p>Votre demande <b>${demande.reference}</b> n'a pas été terminée sous 48h. Les fonds (<b>${amount} FCFA</b>) ont été remboursés.</p>`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        logger.error(
          `Échec e-mail remboursement pour ${client.id}: ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }.`,
        );
      }
    }

    logger.log(
      `Escrow remboursé : demande ${demande.id} (${demande.reference}), ${amount} FCFA crédités à ${client.id}.`,
    );
  }
}
