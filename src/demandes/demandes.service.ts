import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from './../prisma/prisma.service.js';
import type { MediaKind } from './../generated/prisma/enums.js';
import type { CreateDemandeDto } from './dto/create-demande.dto.js';
import type { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import { assertTransition } from './demandes-lifecycle.js';
import { ALLOWED_CATEGORIES } from './categories.js';
import { FinancialService } from '../financial/financial.service.js';
import {
  buildNotification,
  createNotification,
  eventTypeForStatus,
  recordEvent,
} from '../mission-events/mission-events.js';

export const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const REFERENCE_LENGTH = 6;
export const REFERENCE_MAX_ATTEMPTS = 5;

export function generateReference(): string {
  let reference = 'RD-';
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
  domainId: string | null;
  brandId: string | null;
  modelId: string | null;
  problemId: string | null;
  negotiationRequestedAt: Date | null;
  finalAmount: number | null;
  medias: DemandeMediaRow[];
  technician?: DemandeTechnicianInfo | null;
  domain?: { id: string; name: string; slug: string } | null;
  brand?: { id: string; name: string; slug: string } | null;
  model?: { id: string; name: string; slug: string } | null;
  problem?: { id: string; name: string; slug: string } | null;
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
    negotiationRequestedAt: demande.negotiationRequestedAt
      ? demande.negotiationRequestedAt.toISOString()
      : null,
    finalAmount: demande.finalAmount,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: FinancialService,
  ) {}

  async create(clientId: string, dto: CreateDemandeDto) {
    const medias = dto.medias ?? [];
    const requestedMode = dto.requestedMode ?? 'ASAP';
    const requestedAt = resolveRequestedAt(requestedMode, dto.requestedAt);
    const device = await this.resolveDevice(dto);

    for (let attempt = 0; attempt < REFERENCE_MAX_ATTEMPTS; attempt += 1) {
      const reference = generateReference();
      try {
        const demande = await this.prisma.$transaction(async (tx) => {
          const created = await tx.demande.create({
            data: {
              reference,
              category: device.category,
              description: dto.description,
              city: dto.city,
              neighborhood: dto.neighborhood ?? null,
              address: dto.address ?? null,
              landmark: dto.landmark ?? null,
              contactPhone: dto.contactPhone ?? null,
              clientId,
              requestedMode,
              requestedAt,
              domainId: device.domainId,
              brandId: device.brandId,
              modelId: device.modelId,
              problemId: device.problemId,
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
            include: this.clientInclude(),
          });

          // Sprint 8.3 : premier événement du journal métier de la mission.
          await recordEvent(tx, {
            demandeId: created.id,
            type: 'CREATED',
            actorUserId: clientId,
            toStatus: 'SUBMITTED',
          });

          return created;
        });

        return toApiDemande(this.withTechnician(demande));
      } catch (error) {
        // Collision sur la référence générée : on regénère une nouvelle référence.
        if ((error as { code?: string }).code === 'P2002') continue;
        throw error;
      }
    }

    throw new Error('Impossible de générer une référence unique. Réessayez.');
  }

  /* Résolution du contexte appareil (Sprint 8.1) :
   * - le problème est prioritaire pour déterminer le domaine ;
   * - le domaine actif fournit la catégorie métier (category) ;
   * - marque/modèle/problème doivent appartenir au bon parent sinon 400. */
  private async resolveDevice(dto: CreateDemandeDto): Promise<{
    domainId: string | null;
    brandId: string | null;
    modelId: string | null;
    problemId: string | null;
    category: string;
  }> {
    let domainId = dto.domainId ?? null;
    let brandId = dto.brandId ?? null;
    let modelId = dto.modelId ?? null;
    let problemId = dto.problemId ?? null;
    let category = dto.categoryId;

    if (domainId) {
      const domain = await this.prisma.serviceDomain.findUnique({ where: { id: domainId } });
      if (!domain) throw new BadRequestException('Domaine d\'appareil introuvable.');
      if (!domain.isActive) {
        throw new BadRequestException('Ce domaine d\'appareil n\'est plus disponible.');
      }
      if (domain.category) category = domain.category;
    }

    if (brandId) {
      const brand = await this.prisma.deviceBrand.findUnique({ where: { id: brandId } });
      if (!brand) throw new BadRequestException('Marque introuvable.');
      if (!brand.isActive) throw new BadRequestException('Cette marque n\'est plus disponible.');
      if (domainId && brand.domainId !== domainId) {
        throw new BadRequestException('La marque ne dépend pas de ce domaine.');
      }
      domainId = brand.domainId;
    }

    if (modelId) {
      const model = await this.prisma.deviceModel.findUnique({ where: { id: modelId } });
      if (!model) throw new BadRequestException('Modèle introuvable.');
      if (!model.isActive) throw new BadRequestException('Ce modèle n\'est plus disponible.');
      if (brandId && model.brandId !== brandId) {
        throw new BadRequestException('Le modèle ne dépend pas de cette marque.');
      }
      brandId = model.brandId;
    }

    if (problemId) {
      const problem = await this.prisma.problem.findUnique({ where: { id: problemId } });
      if (!problem) throw new BadRequestException('Problème introuvable.');
      if (!problem.isActive) throw new BadRequestException('Ce problème n\'est plus disponible.');
      if (domainId && problem.domainId !== domainId) {
        throw new BadRequestException('Le problème ne dépend pas de ce domaine.');
      }
      domainId = problem.domainId;
      if (problem.brandId && brandId && problem.brandId !== brandId) {
        throw new BadRequestException(
          'Le problème sélectionné ne correspond pas à la marque de l\'appareil.',
        );
      }
      if (problem.brandId && !brandId) brandId = problem.brandId;
      if (problem.modelId && modelId && problem.modelId !== modelId) {
        throw new BadRequestException(
          'Le problème sélectionné ne correspond pas au modèle de l\'appareil.',
        );
      }
      if (problem.modelId && !modelId) modelId = problem.modelId;
    }

    if (domainId) {
      const domain = await this.prisma.serviceDomain.findUnique({ where: { id: domainId } });
      if (domain?.category) category = domain.category;
    }

    return { domainId, brandId, modelId, problemId, category };
  }

  /* Missions actives : tout sauf le terminal (confirmé / annulé).
   * L'historique est exposé séparément via listForClientHistory. */
  async listForClient(clientId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: {
        clientId,
        status: { notIn: ['CONFIRMED', 'CANCELED'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: this.clientInclude(),
    });
    return demandes.map((demande) => toApiDemande(this.withTechnician(demande)));
  }

  async listForClientHistory(clientId: string) {
    const demandes = await this.prisma.demande.findMany({
      where: {
        clientId,
        status: { in: ['CONFIRMED', 'CANCELED'] },
      },
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

      const updated = await tx.demande.update({
        where: { id: current.id },
        data: { status: dto.status },
        include: this.clientInclude(),
      });

      // Sprint 8.3 : journal métier de la transition + notification
      // éventuelle (confirmation → technicien assigné).
      const type = eventTypeForStatus(dto.status);
      if (type) {
        await recordEvent(tx, {
          demandeId: current.id,
          type,
          actorUserId: clientId,
          fromStatus: current.status,
          toStatus: dto.status,
        });

        if (type === 'CONFIRMED' && current.technicianId) {
          await createNotification(
            tx,
            buildNotification('CONFIRMED', current.id, current.technicianId, 'TECHNICIAN'),
          );
        }
      }

      // Sprint 8.7-FIN — règlement financier ATOMIQUE avec la transition :
      //   CONFIRMED → rémunération du technicien (réparation + transport
      //              − frais RepairDom 150), aucune écriture à COMPLETED.
      //   CANCELED  → contrepassation intégrale du client s'il avait été
      //              débité (réparation + transport + frais 100).
      // Dans les deux cas rien n'est écrit si la mission est legacy (aucune
      // transaction financière rétroactive). Tout est idempotent.
      if (dto.status === 'CONFIRMED') {
        await this.financial.settleTechnicianAtConfirmation(tx, {
          demandeId: current.id,
          technicianId: current.technicianId,
          createdById: clientId,
        });
      }
      if (dto.status === 'CANCELED') {
        await this.financial.reverseClientDebitIfAny(tx, {
          demandeId: current.id,
          clientId,
        });
      }

      return updated;
    });

    if (!result) throw new NotFoundException('Demande introuvable.');
    return toApiDemande(this.withTechnician(result));
  }

  private clientInclude() {
    return {
      medias: true,
      domain: { select: { id: true, name: true, slug: true } },
      brand: { select: { id: true, name: true, slug: true } },
      model: { select: { id: true, name: true, slug: true } },
      problem: { select: { id: true, name: true, slug: true } },
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
    domainId: string | null;
    brandId: string | null;
    modelId: string | null;
    problemId: string | null;
    negotiationRequestedAt: Date | null;
    finalAmount: number | null;
    medias: DemandeMediaRow[];
    domain?: { id: string; name: string; slug: string } | null;
    brand?: { id: string; name: string; slug: string } | null;
    model?: { id: string; name: string; slug: string } | null;
    problem?: { id: string; name: string; slug: string } | null;
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