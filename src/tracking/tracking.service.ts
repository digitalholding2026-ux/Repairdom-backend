import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { labelForCategory } from '../demandes/demandes.service.js';

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async trackByReference(reference: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { reference },
      include: {
        domain: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true, slug: true } },
        model: { select: { id: true, name: true, slug: true } },
        problem: { select: { id: true, name: true, slug: true } },
        technician: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            technicianProfile: { select: { kycStatus: true } },
          },
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
    domain: { id: string; name: string; slug: string } | null;
    brand: { id: string; name: string; slug: string } | null;
    model: { id: string; name: string; slug: string } | null;
    problem: { id: string; name: string; slug: string } | null;
    technician: {
      id: string;
      firstName: string;
      lastName: string | null;
      technicianProfile: { kycStatus: string } | null;
    } | null;
  }) {
    const status = demande.status;
    const technicianAssigned = demande.technician !== null;

    return {
      reference: demande.reference,
      status,
      category: labelForCategory(demande.category),
      device: {
        domain: demande.domain
          ? { id: demande.domain.id, name: demande.domain.name, slug: demande.domain.slug }
          : null,
        brand: demande.brand
          ? { id: demande.brand.id, name: demande.brand.name, slug: demande.brand.slug }
          : null,
        model: demande.model
          ? { id: demande.model.id, name: demande.model.name, slug: demande.model.slug }
          : null,
        problem: demande.problem
          ? { id: demande.problem.id, name: demande.problem.name, slug: demande.problem.slug }
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
    };
  }
}
