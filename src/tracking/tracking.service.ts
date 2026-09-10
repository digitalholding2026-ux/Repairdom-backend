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
