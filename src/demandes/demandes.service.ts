import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from './../prisma/prisma.service.js';
import type { MediaKind } from './../generated/prisma/enums.js';
import type { CreateDemandeDto } from './dto/create-demande.dto.js';
import type { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import { assertTransition } from './demandes-lifecycle.js';
import { FinancialService } from '../financial/financial.service.js';
import { DispatchService } from '../dispatch/dispatch.service.js';
// Correctif boucle circulaire DISPATCH-V1 : les helpers purs vivent dans le
// module feuille `./demande-helpers.js` (aucune dépendance de service).
// Ré-exportés ici pour compatibilité des imports existants.
export {
  compareDemandePriority,
  hasCategory,
  isAsapMode,
  isMatchingStatus,
  labelForCategory,
  resolveRequestedAt,
  toApiDemande,
  toApiDemandePublic,
} from './demande-helpers.js';
export type {
  DemandeCategory,
  DemandeMediaRow,
  DemandeRecord,
  DemandeTechnicianInfo,
} from './demande-helpers.js';
import type { DemandeMediaRow, DemandeRecord } from './demande-helpers.js';
import { resolveRequestedAt, toApiDemande } from './demande-helpers.js';
import {
  findCityMatches,
  resolveCityIdFromCandidates,
  resolveGeoFromText,
} from '../geo/city-reference.js';
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

@Injectable()
export class DemandesService {
  private readonly logger = new Logger(DemandesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: FinancialService,
    private readonly dispatch: DispatchService,
  ) {}

  async create(clientId: string, dto: CreateDemandeDto) {
    const medias = dto.medias ?? [];
    const requestedMode = dto.requestedMode ?? 'ASAP';
    const requestedAt = resolveRequestedAt(requestedMode, dto.requestedAt);
    const device = await this.resolveDevice(dto);
    // Sprint 8.8.2 (règles D + E) — rattachement géographique structuré,
    // résolu AVANT la transaction : ville non bloquante + validation zone.
    const geo = await this.resolveDemandeGeo(dto);

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
              cityId: geo.cityId,
              zoneId: geo.zoneId,
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

        // Sprint DISPATCH-V1 — vague 1 APRÈS commit créateur : un échec du
        // dispatch (vague, notification, e-mail) ne doit JAMAIS annuler ni
        // casser la création de la demande (tracé, poursuite en vague 2).
        try {
          await this.dispatch.dispatchWave1(demande.id);
        } catch (error) {
          this.logger.error(
            `Dispatch vague 1 impossible pour ${demande.id} : ${
              error instanceof Error ? error.message : 'erreur inconnue'
            }.`,
          );
        }

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

  /* Rattachement géographique structuré (canonique, non bloquant).
   * - Sans `zoneId` : `resolveGeoFromText` (ville exacte → tête « ville,
   *   région » → nom de zone seul → typo sûre, chaque niveau exigeant
   *   unicité + activité ; sinon { null, null }, texte conservé).
   * - Avec `zoneId` : la zone doit exister et être active ; si la demande a
   *   déjà un `cityId`, la zone doit appartenir à cette ville ; sinon le
   *   `cityId` est dérivé de la zone, sauf contradiction explicite entre le
   *   texte de ville (résolu sans ambiguïté vers une AUTRE ville) et la zone.
   * Le texte original (`dto.city`) n'est jamais modifié ni remplacé. */
  private async resolveDemandeGeo(dto: CreateDemandeDto): Promise<{
    cityId: string | null;
    zoneId: string | null;
  }> {
    const cities = await this.prisma.serviceCity.findMany({
      where: { isActive: true },
      select: { id: true, name: true, slug: true, isActive: true },
    });

    if (!dto.zoneId) {
      const zones = await this.prisma.zone.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true, cityId: true, isActive: true },
      });
      return resolveGeoFromText(cities, zones, dto.city);
    }

    const resolvedCityId = resolveCityIdFromCandidates(cities, dto.city);

    const zone = await this.prisma.zone.findUnique({
      where: { id: dto.zoneId },
      include: { city: { select: { id: true, isActive: true } } },
    });
    if (!zone) throw new NotFoundException('Zone introuvable.');
    if (!zone.isActive) {
      throw new BadRequestException('Cette zone n’est plus disponible.');
    }
    if (!zone.city.isActive) {
      throw new BadRequestException('La ville de cette zone n’est plus disponible.');
    }

    if (resolvedCityId) {
      if (zone.cityId !== resolvedCityId) {
        throw new BadRequestException(
          'La zone sélectionnée n’appartient pas à la ville de la demande.',
        );
      }
      return { cityId: resolvedCityId, zoneId: zone.id };
    }

    // Pas de `cityId` résolu : le texte reste la référence d'affichage, la
    // zone devient la référence structurée — sauf si le texte désigne sans
    // ambiguïté une AUTRE ville du référentiel (contradiction explicite).
    const textMatches = findCityMatches(cities, dto.city);
    if (textMatches.length === 1 && textMatches[0].id !== zone.cityId) {
      throw new BadRequestException(
        'La zone sélectionnée n’appartient pas à la ville de la demande.',
      );
    }
    return { cityId: zone.cityId, zoneId: zone.id };
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

      // Sprint SASPAY-01 (durcissement) : mutation conditionnelle atomique
      // sur le statut lu (updateMany gardé). Deux transitions concurrentes
      // (ex. CONFIRMED + CANCELED, ou double CONFIRMED par retry) ne peuvent
      // plus s'écraser silencieusement : la perdante obtient count = 0 et
      // reçoit un 409. assertTransition, journal, notifications, transaction
      // Prisma et idempotence ledger sont préservés.
      const claimed = await tx.demande.updateMany({
        where: { id: current.id, clientId, status: current.status },
        data: { status: dto.status },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Cette mission a été modifiée entre-temps. Veuillez réactualiser avant de réessayer.',
        );
      }
      const updated = await tx.demande.findFirstOrThrow({
        where: { id: current.id, clientId },
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

      // Règle Relio — règlement financier ATOMIQUE avec la transition :
      //   CONFIRMED → rémunération du technicien (brut réparation + transport
      //              2 000, moins commission Relio 2 %), aucune écriture à
      //              COMPLETED (la commission n'est due qu'à la validation).
      //   CANCELED  → contrepassation intégrale du client s'il avait été
      //              débité (brut + éventuels frais legacy).
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
      zoneRef: { select: { id: true, name: true, slug: true, cityId: true } },
      cityRef: { select: { id: true, name: true, slug: true } },
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
    cityId: string | null;
    zoneId: string | null;
    zoneRef?: { id: string; name: string; slug: string; cityId: string } | null;
    cityRef?: { id: string; name: string; slug: string } | null;
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