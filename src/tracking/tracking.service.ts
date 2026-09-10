import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { labelForCategory } from '../demandes/demandes.service.js';
import { eventLabel } from '../mission-events/mission-events.js';

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async trackByReference(reference: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { reference },
      include: {
        domain: { select: { name: true, slug: true } },
        brand: { select: { name: true, slug: true } },
        model: { select: { name: true, slug: true } },
        problem: { select: { name: true, slug: true } },
        technician: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            technicianProfile: { select: { kycStatus: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { type: true, createdAt: true },
        },
      },
    });

    if (!demande) {
      throw new NotFoundException('Aucune intervention ne correspond à cette référence.');
    }

    return this.buildPublicTracking(demande);
  }

  private buildPublicTracking(demande: {
    reference: string;
    status: string;
    category: string;
    requestedMode: string;
    requestedAt: Date | null;
    scheduledAt: Date | null;
    createdAt: Date;
    domain: { name: string; slug: string } | null;
    brand: { name: string; slug: string } | null;
    model: { name: string; slug: string } | null;
    problem: { name: string; slug: string } | null;
    technician: {
      id: string;
      firstName: string;
      lastName: string | null;
      technicianProfile: { kycStatus: string } | null;
    } | null;
    events: { type: string; createdAt: Date }[];
  }) {
    const status = demande.status;
    const technicianAssigned = demande.technician !== null;

    return {
      reference: demande.reference,
      status,
      category: labelForCategory(demande.category),
      device: {
        domain: demande.domain
          ? { name: demande.domain.name, slug: demande.domain.slug }
          : null,
        brand: demande.brand
          ? { name: demande.brand.name, slug: demande.brand.slug }
          : null,
        model: demande.model
          ? { name: demande.model.name, slug: demande.model.slug }
          : null,
        problem: demande.problem
          ? { name: demande.problem.name, slug: demande.problem.slug }
          : null,
      },
      timing: {
        mode: demande.requestedMode,
        requestedAt: demande.requestedAt ? demande.requestedAt.toISOString() : null,
      },
      scheduledAt: demande.scheduledAt ? demande.scheduledAt.toISOString() : null,
      submittedAt: demande.createdAt.toISOString(),
      technicianAssigned,
      technicianVerified:
        demande.technician?.technicianProfile?.kycStatus === 'VERIFIED',
      // Sprint 8.3 : chronologie publique sécurisée. Aucun identifiant, nom,
      // adresse, téléphone ou montant n'est exposé : uniquement le type de
      // l'événement, son libellé et sa date.
      timeline: this.buildTimeline({
        status,
        createdAt: demande.createdAt,
        scheduledAt: demande.scheduledAt,
        technicianAssigned,
        events: demande.events,
      }),
    };
  }

  /* Timeline publique : les événements réels (Sprint 8.3) dès qu'ils existent,
   * sinon une timeline synthétique minimale dérivée du statut actuel de la
   * demande (compatibilité avec les missions antérieures au journal, sans
   * inventer de dates). */
  private buildTimeline(input: {
    status: string;
    createdAt: Date;
    scheduledAt: Date | null;
    technicianAssigned: boolean;
    events: { type: string; createdAt: Date }[];
  }) {
    if (input.events.length > 0) {
      return input.events.map((event) => ({
        type: event.type,
        label: eventLabel(event.type),
        date: event.createdAt.toISOString(),
      }));
    }

    const timeline: { type: string; label: string; date: string | null }[] = [
      { type: 'CREATED', label: eventLabel('CREATED'), date: input.createdAt.toISOString() },
    ];
    if (input.technicianAssigned && input.status !== 'CANCELED') {
      timeline.push({
        type: 'TECHNICIAN_ACCEPTED',
        label: eventLabel('TECHNICIAN_ACCEPTED'),
        date: null,
      });
    }
    if (input.scheduledAt) {
      timeline.push({
        type: 'SCHEDULED',
        label: eventLabel('SCHEDULED'),
        date: input.scheduledAt.toISOString(),
      });
    }
    if (['IN_PROGRESS', 'COMPLETED', 'CONFIRMED'].includes(input.status)) {
      timeline.push({ type: 'IN_PROGRESS', label: eventLabel('IN_PROGRESS'), date: null });
    }
    if (['COMPLETED', 'CONFIRMED'].includes(input.status)) {
      timeline.push({ type: 'COMPLETED', label: eventLabel('COMPLETED'), date: null });
    }
    if (input.status === 'CONFIRMED') {
      timeline.push({ type: 'CONFIRMED', label: eventLabel('CONFIRMED'), date: null });
    }
    if (input.status === 'CANCELED') {
      timeline.push({ type: 'CANCELED', label: eventLabel('CANCELED'), date: null });
    }
    return timeline;
  }
}
