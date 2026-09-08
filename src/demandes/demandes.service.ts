import { Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from './../prisma/prisma.service.js';
import type { MediaKind } from './../generated/prisma/enums.js';
import type { CreateDemandeDto } from './dto/create-demande.dto.js';

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const REFERENCE_LENGTH = 6;
const REFERENCE_MAX_ATTEMPTS = 5;

interface DemandeMediaRow {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  stored: boolean;
}

interface DemandeWithMedias {
  id: string;
  reference: string;
  status: string;
  category: string;
  description: string;
  city: string;
  address: string | null;
  clientId: string;
  createdAt: Date;
  medias: DemandeMediaRow[];
}

function generateReference(): string {
  let reference = 'RD-';
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    reference += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return reference;
}

@Injectable()
export class DemandesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, dto: CreateDemandeDto) {
    const medias = dto.medias ?? [];

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
              address: dto.address ?? null,
              clientId,
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

        return this.toApiDemande(demande);
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
      include: { medias: true },
    });
    return demandes.map((demande) => this.toApiDemande(demande));
  }

  async findForClient(clientId: string, id: string) {
    const demande = await this.prisma.demande.findFirst({
      where: { id, clientId },
      include: { medias: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    return this.toApiDemande(demande);
  }

  private toApiDemande(demande: DemandeWithMedias) {
    return {
      id: demande.id,
      reference: demande.reference,
      status: demande.status,
      categoryId: demande.category,
      description: demande.description,
      city: demande.city,
      address: demande.address,
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
}