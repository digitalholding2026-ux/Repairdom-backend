import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FinancialService } from '../financial/financial.service.js';
import {
  buildNotification,
  createNotification,
  recordEvent,
  type Tx,
} from '../mission-events/mission-events.js';
import type { RequestUser } from '../auth/auth.types.js';
import { DISPUTE_CATEGORIES, DISPUTE_OPEN_STATUSES } from './dispute-constants.js';
import type { OpenDisputeDto } from './dto/open-dispute.dto.js';
import type { ReviewDisputeDto } from './dto/review-dispute.dto.js';

/* Contestation / litige post-intervention (un par mission, jamais supprimé).
 *
 * Cycle de vie minimal :
 *   OPEN (client) → UNDER_REVIEW (admin) → RESOLVED | REJECTED (admin).
 *   OPEN → RESOLVED | REJECTED direct autorisé (efficacité admin).
 *   RESOLVED/REJECTED terminaux (aucune réouverture, aucune transition).
 *
 * Règles financières (même système, aucun second rail) :
 * - OPEN/UNDER_REVIEW : `CONFIRMED` refusé (409) → aucun règlement, car le
 *   règlement n'a lieu qu'à la confirmation (`settleMissionAtConfirmation`) ;
 * - RESOLVED : hold libéré (`releaseMissionHoldIfAny`, fonds rendus au
 *   client sans écriture) + confirmation définitivement bloquée (un
 *   CONFIRMED post-libération débiterait sans hold — interdit) ;
 * - REJECTED : confirmation à nouveau possible (règlement normal).
 * Jamais d'auto-clôture, jamais de règlement par délai. */

const PARTY_SELECT = {
  select: { id: true, firstName: true, lastName: true },
} as const;

function toApiDispute(
  dispute: Record<string, unknown> & {
    createdAt: Date;
    updatedAt: Date;
    decidedAt?: Date | null;
    demande?: { id: string; reference: string; status: string } | null;
    openedBy?: { id: string; firstName: string; lastName: string | null } | null;
    decider?: { id: string; firstName: string; lastName: string | null } | null;
  },
) {
  return {
    id: dispute.id,
    demandeId: dispute.demandeId,
    category: dispute.category,
    description: dispute.description,
    status: dispute.status,
    resolution: (dispute.resolution as string | null) ?? null,
    decidedAt: dispute.decidedAt ? (dispute.decidedAt as Date).toISOString() : null,
    createdAt: dispute.createdAt.toISOString(),
    updatedAt: dispute.updatedAt.toISOString(),
    ...(dispute.demande ? { demande: dispute.demande } : {}),
    ...(dispute.openedBy ? { openedBy: dispute.openedBy } : {}),
    ...(dispute.decider ? { decider: dispute.decider } : {}),
  };
}

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: FinancialService,
  ) {}

  /* Ouverture client : mission COMPLETED, technicien assigné, aucun litige
   * existant (unicité `demandeId` en base + garde applicative). */
  async openDispute(clientId: string, demandeId: string, dto: OpenDisputeDto) {
    if (!dto || !(DISPUTE_CATEGORIES as readonly string[]).includes(dto.category)) {
      throw new BadRequestException('Motif de contestation invalide.');
    }
    const description = dto.description?.trim() ?? '';
    if (description.length < 10 || description.length > 2000) {
      throw new BadRequestException('La description du litige doit contenir entre 10 et 2000 caractères.');
    }
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, status: true, clientId: true, technicianId: true },
    });
    if (!demande || demande.clientId !== clientId) {
      throw new NotFoundException('Demande introuvable.');
    }
    if (demande.status !== 'COMPLETED') {
      throw new ConflictException('Seule une mission terminée peut être contestée.');
    }
    if (!demande.technicianId) {
      throw new ConflictException('Aucun technicien n’est associé à cette intervention.');
    }
    const existing = await this.prisma.demandeDispute.findUnique({ where: { demandeId } });
    if (existing) {
      throw new ConflictException('Un litige existe déjà pour cette mission.');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const dispute = await tx.demandeDispute.create({
        data: {
          demandeId,
          openedById: clientId,
          category: dto.category,
          description,
          status: 'OPEN',
        },
        include: { demande: { select: { id: true, reference: true, status: true } } },
      });
      await recordEvent(tx, {
        demandeId,
        type: 'DISPUTE_OPENED',
        actorUserId: clientId,
        fromStatus: 'COMPLETED',
      });
      await createNotification(
        tx,
        buildNotification('DISPUTE_OPENED', demandeId, demande.technicianId as string, 'TECHNICIAN'),
      );
      return dispute;
    });
    // Fan-out admin best-effort (hors transaction : une notification manquée
    // ne doit jamais faire échouer l'ouverture).
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: 'ADMIN', isActive: true },
        select: { id: true },
      });
      for (const admin of admins) {
        await this.prisma.notification.create({
          data: {
            userId: admin.id,
            demandeId,
            type: 'DISPUTE_OPENED',
            title: 'Litige ouvert',
            message: `Un client a ouvert un litige (motif : ${dto.category}). Dossier à examiner.`,
          },
        });
      }
    } catch (error) {
      this.logger.warn(
        `Notification admin impossible pour le litige ${demandeId} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
    }
    return toApiDispute(created as never);
  }

  /* Lecture partie prenante : client propriétaire OU technicien assigné
   * (masqué 404 sinon). Retourne le litige ou null (état UI). */
  async getForParty(user: RequestUser, demandeId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, clientId: true, technicianId: true },
    });
    if (
      !demande ||
      (demande.clientId !== user.id &&
        (demande.technicianId === null || demande.technicianId !== user.id))
    ) {
      throw new NotFoundException('Demande introuvable.');
    }
    const dispute = await this.prisma.demandeDispute.findUnique({
      where: { demandeId },
      include: { demande: { select: { id: true, reference: true, status: true } } },
    });
    return dispute ? toApiDispute(dispute as never) : null;
  }

  /* Vrai si la confirmation est bloquée : tout litige sauf REJECTED
   * (REJECTED rouvre la confirmation ; RESOLVED la bloque définitivement
   * car le hold est libéré — confirmer débiterait sans hold). */
  async isConfirmationBlocked(tx: Tx, demandeId: string): Promise<boolean> {
    const dispute = await tx.demandeDispute.findUnique({ where: { demandeId } });
    return dispute !== null && dispute.status !== 'REJECTED';
  }

  /* Vrai si un litige non tranché bloque le règlement (OPEN/UNDER_REVIEW). */
  async hasOpenDispute(demandeId: string): Promise<boolean> {
    const dispute = await this.prisma.demandeDispute.findUnique({ where: { demandeId } });
    return (
      dispute !== null &&
      (DISPUTE_OPEN_STATUSES as readonly string[]).includes(dispute.status)
    );
  }

  /* Consultation admin : liste paginée (filtre statut optionnel). */
  async listForAdmin(options: { status?: string; page?: number; limit?: number } = {}) {
    const status = options.status?.trim() || null;
    if (status && !['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'].includes(status)) {
      throw new BadRequestException('Statut de litige invalide.');
    }
    const page = Math.max(Number(options.page) || 1, 1);
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
    const where = status ? { status: status as 'OPEN' } : {};
    const [total, rows] = await Promise.all([
      this.prisma.demandeDispute.count({ where }),
      this.prisma.demandeDispute.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          demande: { select: { id: true, reference: true, status: true } },
          openedBy: PARTY_SELECT,
        },
      }),
    ]);
    return { items: rows.map((row) => toApiDispute(row as never)), page, limit, total };
  }

  /* Détail admin : litige + mission + parties (décision traçable). */
  async getForAdmin(id: string) {
    const dispute = await this.prisma.demandeDispute.findUnique({
      where: { id },
      include: {
        demande: { select: { id: true, reference: true, status: true, clientId: true, technicianId: true } },
        openedBy: PARTY_SELECT,
        decider: PARTY_SELECT,
      },
    });
    if (!dispute) throw new NotFoundException('Litige introuvable.');
    return toApiDispute(dispute as never);
  }

  /* Décision administrative (ADMIN, jamais supprimé, jamais auto) :
   * OPEN → UNDER_REVIEW | RESOLVED | REJECTED ;
   * UNDER_REVIEW → RESOLVED | REJECTED ; terminaux immuables.
   * RESOLVED libère le hold dans la même transaction (fonds rendus). */
  async reviewDispute(adminId: string, id: string, dto: ReviewDisputeDto) {
    const dispute = await this.prisma.demandeDispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Litige introuvable.');
    const decision = dto?.decision;
    if (decision !== 'UNDER_REVIEW' && decision !== 'RESOLVED' && decision !== 'REJECTED') {
      throw new BadRequestException('Décision invalide.');
    }
    if (dispute.status === 'RESOLVED' || dispute.status === 'REJECTED') {
      throw new ConflictException('Ce litige est déjà tranché.');
    }
    if (dispute.status === 'UNDER_REVIEW' && decision === 'UNDER_REVIEW') {
      throw new ConflictException('Ce litige est déjà en cours d’examen.');
    }
    const resolution = dto?.resolution?.trim() || null;
    if (decision === 'UNDER_REVIEW') {
      if (resolution) {
        throw new BadRequestException('La prise en charge ne comporte pas de décision.');
      }
    } else if (!resolution) {
      throw new BadRequestException('Une décision administrative motivée est requise.');
    }
    const decided = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.demandeDispute.update({
        where: { id },
        data: {
          status: decision,
          resolution,
          decidedById: decision === 'UNDER_REVIEW' ? null : adminId,
          decidedAt: decision === 'UNDER_REVIEW' ? null : new Date(),
        },
        include: { demande: { select: { id: true, reference: true, status: true } } },
      });
      if (decision !== 'UNDER_REVIEW') {
        await recordEvent(tx, {
          demandeId: dispute.demandeId,
          type: 'DISPUTE_RESOLVED',
          actorUserId: adminId,
          fromStatus: 'COMPLETED',
        });
      }
      if (decision === 'RESOLVED') {
        // Litige fondé : restitution purement interne (même mécanisme que
        // l'annulation — aucune écriture ledger), dans la même transaction.
        await this.financial.releaseMissionHoldIfAny(tx, { demandeId: dispute.demandeId });
      }
      const parties = await tx.demande.findUnique({
        where: { id: dispute.demandeId },
        select: { clientId: true, technicianId: true },
      });
      if (decision !== 'UNDER_REVIEW' && parties) {
        await createNotification(
          tx,
          buildNotification('DISPUTE_RESOLVED', dispute.demandeId, parties.clientId, 'CLIENT'),
        );
        if (parties.technicianId) {
          await createNotification(
            tx,
            buildNotification('DISPUTE_RESOLVED', dispute.demandeId, parties.technicianId, 'TECHNICIAN'),
          );
        }
      }
      return updated;
    });
    return toApiDispute(decided as never);
  }
}
