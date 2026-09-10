import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from './../prisma/prisma.service.js';
import type { MediaKind } from './../generated/prisma/enums.js';
import type { CreateDemandeDto } from './dto/create-demande.dto.js';
import type { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import { assertTransition } from './demandes-lifecycle.js';
import { ALLOWED_CATEGORIES } from './categories.js';

export const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const REFERENCE_LENGTH = 6;
export const REFERENCE_MAX_ATTEMPTS = 5;

export function generateReference(): string {
  const year = String(new Date().getFullYear()).slice(-2);
  let reference = `RD-${year}-`;
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return reference;
}

export type DemandeCategory = (typeof ALLOWED_CATEGORIES)[number];

export interface DemandeTechnicianInfo {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  city: string | null;
}

export interface DemandeMediaRow {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  stored: boolean;
}

export interface DemandeRecord {
  id: string;
  reference: string;
  status: string;
  category: string;
  description: string;
  city: string;
  neighborhood: string | null;
  address: string | null;
  landmark: string | null;
  contactPhone: string | null;
  clientId: string;
  technicianId: string | null;
  scheduledAt: Date | null;
  requestedMode: string;
  requestedAt: Date | null;
  createdAt: Date;
  medias: DemandeMediaRow[];
  technician?: DemandeTechnicianInfo | null;
}

export function toApiDemande(demande: DemandeRecord) {
  return {
    id: demande.id,
    reference: demande.reference,
    status: demande.status,
    categoryId: demande.category,
    categoryLabel: labelForCategory(demande.category),
    description: demande.description,
    city: demande.city,
    neighborhood: demande.neighborhood,
    address: demande.address,
    landmark: demande.landmark,
    contactPhone: demande.contactPhone,
    technicianId: demande.technicianId,
    technician: demande.technician ?? null,
    scheduledAt: demande.scheduledAt ? demande.scheduledAt.toISOString() : null,
    requestedMode: demande.requestedMode,
    requestedAt: demande.requestedAt ? demande.requestedAt.toISOString() : null,
    medias: demande.medias.map((media) => ({
      id: media.id,
      kind: media.kind,
      name: media.fileName,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      stored: media.stored,
    })),
    mediaPersisted: false,
    storageStatus: 'metadata-only',
    createdAt: demande.createdAt.toISOString(),
  };
}

// Sérialisation publique (opportunités) : aucun détail privé (adresse,
// contact téléphonique) n'est exposé tant que le technicien n'est pas assigné.
export function toApiDemandePublic(demande: DemandeRecord) {
  const api = toApiDemande(demande);
  return {
    ...api,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
  };
}

export function hasCategory(category: string): category is DemandeCategory {
  return (ALLOWED_CATEGORIES as readonly string[]).includes(category);
}

export function isMatchingStatus(status: string): status is 'SUBMITTED' | 'PENDING' {
  return status === 'SUBMITTED' || status === 'PENDING';
}

export function isAsapMode(mode: string): boolean {
  return mode === 'ASAP';
}

export function resolveRequestedAt(mode: string, requestedAt?: string): Date | null {
  if (mode === 'SCHEDULED') {
    if (!requestedAt) {
      throw new BadRequestException(
        'Veuillez préciser la date et l\'heure auxquelles vous souhaitez être dépanné.',
      );
    }
    const date = new Date(requestedAt);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('La date d\'intervention souhaitée est invalide.');
    }
    if (date.getTime() <= Date.now()) {
      throw new BadRequestException(
        'La date d\'intervention souhaitée ne peut pas être dans le passé.',
      );
    }
    return date;
  }

  if (requestedAt) {
    throw new BadRequestException(
      'Une intervention « dès que possible » ne doit pas comporter de date souhaitée.',
    );
  }
  return null;
}

export function labelForCategory(category: string): string {
  const labels: Record<string, string> = {
    electricite: 'Électricité',
    plomberie: 'Plomberie',
    climatisation: 'Climatisation',
    electromenager: 'Électroménager',
    serrurerie: 'Serrurerie',
    informatique: 'Informatique',
    autre: 'Autre',
  };
  return labels[category] ?? category;
}

@Injectable()
export class DemandesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, dto: CreateDemandeDto) {
    const medias = dto.medias ?? [];
    const requestedMode = dto.requestedMode ?? 'ASAP';
    const requestedAt = resolveRequestedAt(requestedMode, dto.requestedAt);

    for (let attempt = 0; attempt < REFERENCE_MAX_ATTEMPTS; attempt += 1) {
      const reference = generateReference();
      try {
        const demande = await this.prisma.$transaction((tx) =>
          tx.demande.create({
            data: {
              reference,
              category: dto.categoryId,
              description: dto.description,
              city: dto.city,
              neighborhood: dto.neighborhood ?? null,
              address: dto.address ?? null,
              landmark: dto.landmark ?? null,
              contactPhone: dto.contactPhone ?? null,
              clientId,
              requestedMode,
              requestedAt,
              medias:
                medias.length > 0
                  ? {
                      create: medias.map((media) => ({
                        kind: media.kind as MediaKind,
                        fileName: media.name,
                        mimeType: media.mimeType,
                        sizeBytes: media.sizeBytes,
                      })),
                    }
                  : undefined,
            },
            include: { medias: true },
          }),
        );

        return toApiDemande(demande);
      } catch (error) {
        // Collision sur la référence générée : on regénère une nouvelle référence.
        if ((error as { code?: string }).code === 'P2002') continue;
        throw error;
      }
    }

    throw new Error('Impossible de générer une référence unique. Réessayez.');
  }

  async listForClient(clientId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: this.clientInclude(),
    });
    return demandes.map((demande) => toApiDemande(this.withTechnician(demande)));
  }

  async findForClient(clientId: string, id: string) {
    const demande = await this.prisma.demande.findFirst({
      where: { id, clientId },
      include: this.clientInclude(),
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    return toApiDemande(this.withTechnician(demande));
  }

  async updateStatus(clientId: string, id: string, dto: UpdateDemandeStatusDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.demande.findFirst({
        where: { id, clientId },
      });
      if (!current) return null;

      assertTransition('CLIENT', current.status, dto.status);

      return tx.demande.update({
        where: { id: current.id },
        data: { status: dto.status },
        include: this.clientInclude(),
      });
    });

    if (!result) throw new NotFoundException('Demande introuvable.');
    return toApiDemande(this.withTechnician(result));
  }

  private clientInclude() {
    return {
      medias: true,
      technician: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          technicianProfile: { select: { city: true } },
        },
      },
    };
  }

  private withTechnician(demande: {
    id: string;
    reference: string;
    status: string;
    category: string;
    description: string;
    city: string;
    neighborhood: string | null;
    address: string | null;
    landmark: string | null;
    contactPhone: string | null;
    clientId: string;
    technicianId: string | null;
    scheduledAt: Date | null;
    requestedMode: string;
    requestedAt: Date | null;
    createdAt: Date;
    medias: DemandeMediaRow[];
    technician?: {
      id: string;
      firstName: string;
      lastName: string | null;
      phone: string | null;
      technicianProfile: { city: string } | null;
    } | null;
  }): DemandeRecord {
    if (!demande.technician) {
      return { ...demande, technician: null };
    }
    return {
      ...demande,
      technician: {
        id: demande.technician.id,
        firstName: demande.technician.firstName,
        lastName: demande.technician.lastName,
        phone: demande.technician.phone,
        city: demande.technician.technicianProfile?.city ?? null,
      },
    };
  }
}