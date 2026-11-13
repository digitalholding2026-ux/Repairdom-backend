import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './../prisma/prisma.service.js';
import type { CreateDemandeDto } from './dto/create-demande.dto.js';
import type { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import type { TrackSearchDto } from './dto/track-search.dto.js';
import { assertTransition } from './demandes-lifecycle.js';
import { FinancialService } from '../financial/financial.service.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { missionChannel } from '../realtime/realtime.types.js';
import { RewardsService } from '../rewards/rewards.service.js';
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
  toApiTravelClient,
  toApiTravelMapClient,
} from './demande-helpers.js';
export type {
  DemandeCategory,
  DemandeMediaRow,
  DemandeRecord,
  DemandeTechnicianInfo,
  TravelClientView,
  TravelMapClientView,
  TravelTechnicianView,
} from './demande-helpers.js';
import { toApiDemande, toApiTravelClient, toApiTravelMapClient } from './demande-helpers.js';
import {
  eventTypeForStatus,
  recordEvent,
} from '../mission-events/mission-events.js';

export const REFERENCE_PREFIXES: Record<string, string> = {
  FRP: 'FRP',
  SYSTEME: 'SYS',
  SMARTPHONE: 'SMA',
};

export function referencePrefixFor(serviceCode: string): string {
  return REFERENCE_PREFIXES[serviceCode] ?? 'RD';
}

export async function generateReference(
  prisma: PrismaService,
  serviceCode: string,
): Promise<string> {
  const prefix = referencePrefixFor(serviceCode);
  const latest = await prisma.demande.findFirst({
    where: { reference: { startsWith: `${prefix}-` } },
    orderBy: { createdAt: 'desc' },
    select: { reference: true },
  });

  let next = 1;
  if (latest?.reference) {
    const match = latest.reference.match(/^([A-Z]+)-(\d+)$/);
    if (match) {
      next = Number(match[2]) + 1;
    }
  }

  return `${prefix}-${String(next).padStart(3, '0')}`;
}

@Injectable()
export class DemandesService {
  private readonly logger = new Logger(DemandesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly financial: FinancialService,
    private readonly disputes: DisputesService,
    // Temps réel (socle SSE) : injection optionnelle (tests sans module).
    private readonly realtime?: RealtimeService,
    /* Chantier #4A — programme de récompenses client. OPTIONNEL au sens
     * TypeScript (`?`) comme `realtime` ci-dessus : les tests unitaires de
     * `DemandesService` n'instancient pas `RewardsModule` et le comptage des
     * récompenses est alors simplement sauté. Déclaré EN DERNIER pour ne pas
     * décaler les positions des paramètres optionnels existants.
     * Côté Nest la résolution est effective (`DemandesModule` importe
     * `RewardsModule`). */
    private readonly rewards?: RewardsService,
  ) {}

  async create(clientId: string | null, dto: CreateDemandeDto) {
    /* Résolution du client pour une demande anonyme (pas de JWT) :
     * - rechercher un utilisateur existant avec ce numéro de téléphone ;
     * - sinon, créer un utilisateur "fantôme" (CLIENT, B2C, sans mot de passe,
     *   isActive: true) lié au numéro WhatsApp.
     * Un client authentifié (clientId !== null) est utilisé tel quel. */
    let resolvedClientId: string;
    if (clientId !== null) {
      resolvedClientId = clientId;
    } else if (dto.phone) {
      const existing = await this.prisma.user.findFirst({
        where: { phone: dto.phone },
        select: { id: true },
      });
      if (existing) {
        resolvedClientId = existing.id;
      } else {
        const ghost = await this.prisma.user.create({
          data: {
            role: 'CLIENT',
            clientType: 'CLIENT',
            firstName: 'Client',
            lastName: 'Invité',
            phone: dto.phone,
            email: `guest-${randomUUID()}@relio.local`,
            passwordHash: null,
            emailVerified: true,
            isActive: true,
          },
          select: { id: true },
        });
        resolvedClientId = ghost.id;
      }
    } else {
      throw new BadRequestException(
        'Un numéro de téléphone WhatsApp est requis pour déposer une demande sans compte.',
      );
    }

    const trackingToken = randomUUID();
    const reference = await generateReference(this.prisma, dto.serviceCode);

    /* Vérifier l'existence des clés étrangères optionnelles avant inclusion.
     * Si un ID est invalide, on l'ignore plutôt que de faire échouer toute la
     * demande avec une contrainte de clé étrangère. */
    const [brand, model, problem] = await Promise.all([
      dto.brandId ? this.prisma.deviceBrand.findUnique({ where: { id: dto.brandId }, select: { id: true } }) : null,
      dto.modelId ? this.prisma.deviceModel.findUnique({ where: { id: dto.modelId }, select: { id: true } }) : null,
      dto.problemId ? this.prisma.problem.findUnique({ where: { id: dto.problemId }, select: { id: true } }) : null,
    ]);

    const demande = await this.prisma.$transaction(async (tx) => {
      const created = await tx.demande.create({
        data: {
          reference,
          category: dto.serviceCode,
          description: dto.description?.trim() || null,
          address: dto.address,
          contactPhone: dto.phone,
          city: dto.address,
          clientId: resolvedClientId,
          trackingToken,
          ...(brand ? { brandId: dto.brandId } : {}),
          ...(model ? { modelId: dto.modelId } : {}),
          ...(problem ? { problemId: dto.problemId } : {}),
          ...(dto.catalogItemId ? { catalogItemId: dto.catalogItemId } : {}),
          ...(dto.finalAmount !== undefined ? { finalAmount: dto.finalAmount } : {}),
          ...(dto.extraRequirements ? { extraRequirements: dto.extraRequirements } : {}),
        },
        include: this.clientInclude(),
      });

      // Premier événement du journal métier de la mission.
      await recordEvent(tx, {
        demandeId: created.id,
        type: 'CREATED',
        actorUserId: resolvedClientId,
        toStatus: 'SUBMITTED',
      });

      return created;
    });

    return { ...toApiDemande(demande), trackingToken: demande.trackingToken };
  }

  /* Recherche publique d'une demande par sa référence lisible (ex: FRP-023).
   * Exige le numéro de téléphone associé (query param `phone`) pour
   * verrouiller l'accès aux données personnelles (adresse, téléphone).
   * Retourne 403 si le numéro est absent ou incorrect. */
  async findByReference(reference: string, phone?: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { reference: reference.trim().toUpperCase() },
      include: {
        domain: { select: { name: true } },
        brand: { select: { name: true } },
        model: { select: { name: true } },
        problem: { select: { name: true } },
        catalogItem: { select: { label: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: { type: true, createdAt: true },
        },
      },
    });

    if (!demande) {
      throw new NotFoundException('Aucune demande ne correspond à cette référence.');
    }

    /* Vérifier le numéro de téléphone fourni contre celui de la demande.
     * Normalisation : garder uniquement les chiffres. */
    const normalize = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');
    const demandePhone = normalize(demande.contactPhone);
    const providedPhone = normalize(phone);

    if (!demandePhone || !providedPhone || demandePhone !== providedPhone) {
      throw new ForbiddenException('Numéro de téléphone incorrect.');
    }

    return {
      reference: demande.reference,
      status: demande.status,
      category: demande.domain ? demande.domain.name : demande.category,
      model: demande.catalogItem?.label ?? demande.model?.name ?? null,
      problem: demande.problem ? demande.problem.name : null,
      price: demande.finalAmount ?? null,
      createdAt: demande.createdAt.toISOString(),
      address: demande.address ?? null,
      city: demande.city,
      contactPhone: demande.contactPhone ?? null,
      timeline: demande.events.map((e) => ({
        type: e.type,
        label: e.type,
        date: e.createdAt.toISOString(),
      })),
    };
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
    return demandes.map((demande) => toApiDemande(demande));
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
    return demandes.map((demande) => toApiDemande(demande));
  }

  async findForClient(clientId: string, id: string) {
    const demande = await this.prisma.demande.findFirst({
      where: { id, clientId },
      include: {
        ...this.clientInclude(),
        fundsHolds: { select: { id: true, status: true } },
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    // M2 — statut de l'escrow pour le timer côté client.
    const activeHold = demande.fundsHolds?.some((h) => h.status === 'ACTIVE');
    const fundsHoldStatus = demande.escrowStartedAt
      ? activeHold
        ? 'ACTIVE'
        : demande.status === 'COMPLETED'
          ? 'COMPLETED'
          : 'REFUNDED'
      : null;

    // GPS V3 — vue déplacement SANS coordonnées brutes (jamais exposées
    // au client) : statut, fraîcheur et distance approximative uniquement.
    // GPS V4 — `travelMap` : point technicien pour le RENDU carte,
    // uniquement si déplacement actif ET position fraîche (jamais de
    // chiffres affichés côté UI). Réservé au détail (jamais les listes).
    return {
      ...toApiDemande(demande),
      escrowStatus: fundsHoldStatus,
      travel: toApiTravelClient(demande),
      travelMap: toApiTravelMapClient(demande),
    };
  }

  async updateStatus(clientId: string, id: string, dto: UpdateDemandeStatusDto) {
    // Capturés dans la transaction, diffusés après commit.
    let fromStatus: string | null = null;
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

      }

      // Règle Relio (SASPAY-02) — règlement financier ATOMIQUE avec la
      // transition (même transaction que le changement de statut gardé) :
      //   CONFIRMED → hold mission CONSUMED + débit client définitif
      //              (brut réparation + transport 2 000) + rémunération du
      //              technicien (brut − commission Relio 2 %). Aucune écriture
      //              à COMPLETED (la commission n'est due qu'à la validation).
      //   CANCELED  → hold mission RELEASED (fonds à nouveau disponibles,
      //              SANS écriture : ni topup, ni payout, ni faux dépôt) +
      //              contrepassation legacy si un CLIENT_MISSION_DEBIT
      //              historique existe (no-op pour les missions à hold).
      // Missions legacy sans quote ACCEPTED : aucune écriture (pas de hold
      // rétroactif, pas de conversion d'historique). Tout est idempotent.
      if (dto.status === 'CONFIRMED') {
        // Litige : aucun règlement tant qu'un litige bloque la mission
        // (OPEN/UNDER_REVIEW en cours, ou RESOLVED dont le hold est libéré —
        // confirmer débiterait sans hold). Seul REJECTED rouvre la voie.
        // Vérifié DANS la transaction (ouverture concurrente impossible).
        if (await this.disputes.isConfirmationBlocked(tx, current.id)) {
          throw new ConflictException(
            'Un litige est en cours sur cette mission : la confirmation est suspendue jusqu’à la décision de l’administration.',
          );
        }
        await this.financial.settleMissionAtConfirmation(tx, {
          demandeId: current.id,
          clientId,
          technicianId: null,
          createdById: clientId,
        });
      }
      if (dto.status === 'CANCELED') {
        await this.financial.releaseMissionHoldIfAny(tx, {
          demandeId: current.id,
        });
        await this.financial.reverseClientDebitIfAny(tx, {
          demandeId: current.id,
          clientId,
        });
      }
      fromStatus = current.status;

      return updated;
    });

    if (!result) throw new NotFoundException('Demande introuvable.');

    // Temps réel (après commit) : changement de statut + notification.
    this.realtime?.publish(missionChannel(id), 'mission.status_changed', {
      demandeId: id,
      fromStatus,
      toStatus: dto.status,
      createdAt: new Date().toISOString(),
    });

    /* Chantier #4A — PROGRESSION DU PROGRAMME DE RÉCOMPENSES.
     *
     * Appelé APRÈS la transaction (et après le règlement financier, qui est
     * donc déjà commité). Le compteur n'avance que sur une mission CONFIRMED
     * payée ≥ 1 500 XAF et sans signalement anti-fraude — voir
     * `RewardsService.onMissionConfirmed`.
     *
     * Le `try/catch` est INDISPENSABLE : le règlement est un fait acquis, on
     * ne doit pas le faire échouer parce qu'un compteur ou une notification de
     * récompense est en erreur. Le seul effet d'un échec ici est un compteur
     * non mis à jour, rattrapable et sans impact financier. */
    if (dto.status === 'CONFIRMED') {
      try {
        await this.rewards?.onMissionConfirmed(id);
      } catch (error) {
        this.logger.error(
          `Comptage des récompenses en échec pour la mission ${id} : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }. La mission reste confirmée et réglée.`,
        );
      }

    }

    return toApiDemande(result);
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
    };
  }

  /* Recherche publique des demandes par numéro de téléphone (client invité,
   * pas de compte). Retourne toutes les demandes liées à ce numéro, triées
   * par date décroissante. */
  async searchByPhone(dto: TrackSearchDto) {
    // Normalisation : garder les chiffres uniquement pour le matching.
    const digits = dto.phone.replace(/\D/g, '');
    if (!digits) {
      throw new BadRequestException('Numéro de téléphone invalide.');
    }

    const demandes = await this.prisma.demande.findMany({
      where: {
        contactPhone: { contains: digits },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        trackingToken: true,
        reference: true,
        category: true,
        status: true,
        createdAt: true,
        finalAmount: true,
      },
    });

    return demandes.map((d) => ({
      id: d.id,
      trackingToken: d.trackingToken,
      reference: d.reference,
      service: d.category,
      status: d.status,
      createdAt: d.createdAt.toISOString(),
      price: d.finalAmount ?? null,
    }));
  }
}