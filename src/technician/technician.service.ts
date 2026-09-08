import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toApiDemande, isMatchingStatus } from '../demandes/demandes.service.js';
import type { UpdateTechnicianProfileDto } from './dto/update-technician-profile.dto.js';

@Injectable()
export class TechnicianService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({
      where: { userId },
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
    });
    if (!profile) throw new NotFoundException('Profil technicien introuvable.');
    return {
      id: profile.id,
      city: profile.city,
      categories: profile.categories,
      createdAt: profile.createdAt.toISOString(),
      user: profile.user,
    };
  }

  async updateProfile(userId: string, dto: UpdateTechnicianProfileDto) {
    const profile = await this.prisma.technicianProfile.upsert({
      where: { userId },
      update: {
        city: dto.city.trim(),
        categories: dto.categories,
      },
      create: {
        userId,
        city: dto.city.trim(),
        categories: dto.categories,
      },
      include: { user: { select: { firstName: true, lastName: true, phone: true, email: true, role: true } } },
    });
    return {
      id: profile.id,
      city: profile.city,
      categories: profile.categories,
      createdAt: profile.createdAt.toISOString(),
      user: profile.user,
    };
  }

  async listAvailable(userId: string) {
    const profile = await this.requireProfile(userId);
    const demandes = await this.prisma.demande.findMany({
      where: {
        status: { in: ['SUBMITTED', 'PENDING'] },
        category: { in: profile.categories },
        city: { equals: profile.city, mode: 'insensitive' },
        technicianId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { medias: true },
    });
    return demandes.map((d) => toApiDemande(d));
  }

  async listMine(userId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: { technicianId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { medias: true },
    });
    return demandes.map((d) => toApiDemande(d));
  }

  async getDemandeDetail(userId: string, demandeId: string) {
    const profile = await this.requireProfile(userId);
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      include: { medias: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    const isAlreadyMine = demande.technicianId === userId;
    if (isAlreadyMine) {
      return toApiDemande(demande);
    }

    const isAvailable =
      isMatchingStatus(demande.status) &&
      profile.categories.includes(demande.category) &&
      demande.city.toLowerCase() === profile.city.toLowerCase() &&
      !demande.technicianId;

    if (!isAvailable) {
      throw new NotFoundException('Demande introuvable.');
    }

    return toApiDemande(demande);
  }

  async acceptDemande(userId: string, demandeId: string) {
    const profile = await this.requireProfile(userId);

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.demande.updateMany({
        where: {
          id: demandeId,
          status: { in: ['SUBMITTED', 'PENDING'] },
          category: { in: profile.categories },
          city: { equals: profile.city, mode: 'insensitive' },
          technicianId: null,
        },
        data: {
          status: 'ACCEPTED',
          technicianId: userId,
        },
      });

      if (updated.count === 0) {
        return null;
      }

      return tx.demande.findUnique({
        where: { id: demandeId },
        include: {
          medias: true,
          client: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    });

    if (!result) {
      const existing = await this.prisma.demande.findUnique({ where: { id: demandeId } });
      if (!existing) throw new NotFoundException('Demande introuvable.');
      if (existing.technicianId) throw new ConflictException('Cette demande a déjà été acceptée par un autre technicien.');
      if (existing.status === 'CANCELED') throw new ConflictException('Cette demande a été annulée.');
      throw new ForbiddenException('Cette demande ne correspond pas à votre profil.');
    }

    return toApiDemande(result);
  }

  private async requireProfile(userId: string) {
    const profile = await this.prisma.technicianProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new BadRequestException('Profil technicien incomplet. Veuillez compléter votre profil.');
    }
    return profile;
  }
}