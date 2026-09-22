import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../auth/email.service.js';
import {
  filterActiveCoverageZoneIdsForCity,
} from '../geo/geo-matching.js';
import {
  isCityMatch,
  isGeoEligible,
  normalizeValue,
} from '../geo/geo-eligibility.js';
import { isMatchingStatus, labelForCategory } from '../demandes/demande-helpers.js';
import {
  buildNotification,
  recordEvent,
} from '../mission-events/mission-events.js';

/* Sprint DISPATCH-V1 — Dispatch intelligent (2 vagues max, STOP ensuite).
 *
 * Principe : NOTIFICATION ≠ ÉLIGIBILITÉ À L'ACCEPTATION. Le KYC n'est PAS
 * exigé pour informer un technicien ; il reste OBLIGATOIRE pour accepter
 * (contrôle `TechnicianService.acceptDemande`, 403 pré-transaction).
 *
 * Vague 1 : techniciens disponibles + `isGeoEligible` (ville + zone, règles
 * de transition préservées), KYC NON REQUIS.
 * Vague 2 (+10 min sans acceptation) : même ville (`isCityMatch`, zone non
 * exigée), hors techniciens déjà sollicités (vague 1), jamais inter-ville,
 * KYC NON REQUIS.
 *
 * Invariants :
 * - `isGeoEligible` / `isCityMatch` sont la source de vérité géographique
 *   (aucune duplication, aucune réécriture).
 * - `DispatchWave @@unique([demandeId, wave, userId, channel])` garantit
 *   l'idempotence (redémarrage, double exécution, relance).
 * - L'acceptation atomique (`updateMany` gardé, inchangée) reste seule juge :
 *   chaque vague revérifie `technicianId IS NULL` + statut avant d'agir, et
 *   seul un technicien KYC VERIFIED peut accepter (garde backend dédiée).
 * - E-mail non bloquant : échec isolé par destinataire, In-App conservée.
 */

export const DISPATCH_WAVE_1 = 1;
export const DISPATCH_WAVE_2 = 2;
export const DISPATCH_MAX_WAVE = 2;
/** Délai vague 1 → vague 2, calculé depuis `sentAt` persisté (jamais mémoire). */
export const DISPATCH_WAVE_2_DELAY_MS = 10 * 60 * 1000;
export const DISPATCH_CHANNEL_IN_APP = 'IN_APP';
export const DISPATCH_CHANNEL_EMAIL = 'EMAIL';

export interface DispatchCandidate {
  userId: string;
  email: string | null;
  city: string;
  cityId: string | null;
  categories: string[];
  isAvailable: boolean;
  kycStatus: string;
  coverageZoneIds: string[];
}

export interface DispatchDemandeGeo {
  city: string;
  cityId: string | null;
  zoneId: string | null;
  category: string;
}

/** Demande encore « dispatchable » : non attribuée + statut de matching. */
export function isDispatchableDemande(demande: {
  status: string;
  technicianId: string | null;
}): boolean {
  return demande.technicianId === null && isMatchingStatus(demande.status);
}

/** Vague 2 due : 10 minutes écoulées depuis l'envoi persisté de la vague 1. */
export function isWave2Due(wave1SentAt: Date, now: Date): boolean {
  return wave1SentAt.getTime() + DISPATCH_WAVE_2_DELAY_MS <= now.getTime();
}

/* Sélection pure (testable sans base) :
 * - vague 1 : `isGeoEligible` (ville + zone, transitions incluses) ;
 * - vague 2 : `isCityMatch` seul (ville entière, zone non exigée) ;
 * - toujours : disponible + catégorie + hors déjà sollicités.
 * Le KYC n'est JAMAIS un critère de notification (ni vague 1, ni vague 2) :
 * un technicien non vérifié est informé comme les autres, mais seul un
 * technicien KYC VERIFIED peut accepter (garde `acceptDemande`, backend). */
export function selectCandidatesForWave(
  candidates: DispatchCandidate[],
  demande: DispatchDemandeGeo,
  wave: typeof DISPATCH_WAVE_1 | typeof DISPATCH_WAVE_2,
  alreadyNotifiedUserIds: readonly string[],
): DispatchCandidate[] {
  const excluded = new Set(alreadyNotifiedUserIds);
  return candidates.filter((candidate) => {
    if (!candidate.isAvailable) return false;
    if (excluded.has(candidate.userId)) return false;
    const categoryOk = candidate.categories.some(
      (category) => normalizeValue(category) === normalizeValue(demande.category),
    );
    if (!categoryOk) return false;
    if (wave === DISPATCH_WAVE_1) {
      return isGeoEligible({
        demandeCityId: demande.cityId,
        demandeCity: demande.city,
        technicianCityId: candidate.cityId,
        technicianCity: candidate.city,
        demandeZoneId: demande.zoneId,
        technicianActiveZoneIds: candidate.coverageZoneIds,
      });
    }
    return isCityMatch(demande.cityId, demande.city, candidate.cityId, candidate.city);
  });
}

interface WaveRunResult {
  wave: number;
  notified: number;
  skipped: boolean;
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.frontendUrl =
      this.config.get<string>('FRONTEND_URL')?.replace(/\/+$/, '') ?? 'https://repairdom.vercel.app';
  }

  /** Vague 1, appelée après création d'une demande (hors transaction créatrice). */
  async dispatchWave1(demandeId: string): Promise<WaveRunResult> {
    return this.runWave(demandeId, DISPATCH_WAVE_1, new Date());
  }

  /** Balayage des vagues 2 dues (scheduler). Idempotent et réentrant. */
  async dispatchDueWave2(now: Date = new Date()): Promise<WaveRunResult[]> {
    const cutoff = new Date(now.getTime() - DISPATCH_WAVE_2_DELAY_MS);
    const wave1Rows = await this.prisma.dispatchWave.findMany({
      where: { wave: DISPATCH_WAVE_1, sentAt: { lte: cutoff } },
      select: { demandeId: true },
      distinct: ['demandeId'],
    });
    if (wave1Rows.length === 0) return [];
    const demandeIds = wave1Rows.map((row) => row.demandeId);
    const wave2Rows = await this.prisma.dispatchWave.findMany({
      where: { demandeId: { in: demandeIds }, wave: DISPATCH_WAVE_2 },
      select: { demandeId: true },
      distinct: ['demandeId'],
    });
    const alreadyWaved2 = new Set(wave2Rows.map((row) => row.demandeId));
    const results: WaveRunResult[] = [];
    for (const demandeId of demandeIds) {
      if (alreadyWaved2.has(demandeId)) continue;
      try {
        results.push(await this.runWave(demandeId, DISPATCH_WAVE_2, now));
      } catch (error) {
        this.logger.error(
          `Vague 2 impossible pour ${demandeId} : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
        );
      }
    }
    return results;
  }

  private async runWave(
    demandeId: string,
    wave: typeof DISPATCH_WAVE_1 | typeof DISPATCH_WAVE_2,
    now: Date,
  ): Promise<WaveRunResult> {
    // §8 — relecture systématique : STOP si attribuée, annulée/terminée,
    // ou si cette vague existe déjà (idempotence inter-exécutions).
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        reference: true,
        status: true,
        category: true,
        city: true,
        cityId: true,
        zoneId: true,
        technicianId: true,
      },
    });
    if (!demande || !isDispatchableDemande(demande)) {
      return { wave, notified: 0, skipped: true };
    }
    const existingWave = await this.prisma.dispatchWave.findFirst({
      where: { demandeId, wave },
      select: { id: true },
    });
    if (existingWave) {
      return { wave, notified: 0, skipped: true };
    }

    const alreadyNotified = await this.prisma.dispatchWave.findMany({
      where: { demandeId },
      select: { userId: true },
      distinct: ['userId'],
    });
    const candidates = await this.loadCandidates();
    const selected = selectCandidatesForWave(
      candidates,
      { city: demande.city, cityId: demande.cityId, zoneId: demande.zoneId, category: demande.category },
      wave,
      alreadyNotified.map((row) => row.userId),
    );

    const emailOk = this.email.isConfigured;
    if (!emailOk) {
      this.logger.warn(`Resend non configuré : vague ${wave} sans e-mail pour ${demandeId}.`);
    }
    const sentAt = now;

    // Persistance atomique : traces de vague + notifications In-App +
    // événement de vague. Les e-mails partent APRÈS (non bloquants).
    await this.prisma.$transaction(async (tx) => {
      await tx.dispatchWave.createMany({
        data: selected.flatMap((candidate) => {
          const rows = [
            {
              demandeId,
              userId: candidate.userId,
              wave,
              channel: DISPATCH_CHANNEL_IN_APP,
              sentAt,
            },
          ];
          if (emailOk && candidate.email) {
            rows.push({
              demandeId,
              userId: candidate.userId,
              wave,
              channel: DISPATCH_CHANNEL_EMAIL,
              sentAt,
            });
          }
          return rows;
        }),
        skipDuplicates: true,
      });
      if (selected.length > 0) {
        await tx.notification.createMany({
          data: selected.map((candidate) => {
            const built = buildNotification('MISSION_AVAILABLE', demandeId, candidate.userId, 'TECHNICIAN');
            return {
              userId: built.userId,
              demandeId: built.demandeId,
              type: built.type,
              title: built.title,
              message: built.message,
            };
          }),
        });
      }
      await recordEvent(tx, {
        demandeId,
        type: 'DISPATCH_WAVE',
        toStatus: demande.status,
        metadata: { wave, candidateCount: selected.length },
      });
    });

    // E-mails isolés par destinataire : un échec ne remet jamais en cause
    // la vague ni les notifications In-App déjà persistées.
    if (emailOk) {
      const demandeLink = `${this.frontendUrl}/technicien/demandes/${demandeId}`;
      for (const candidate of selected) {
        if (!candidate.email) continue;
        try {
          await this.email.sendMissionAvailable(candidate.email, {
            demandeLink,
            city: demande.city,
            categoryLabel: labelForCategory(demande.category),
            reference: demande.reference,
          });
        } catch (error) {
          this.logger.error(
            `E-mail mission indisponible pour ${demandeId} (${candidate.userId}) : ${
              error instanceof Error ? error.message : 'erreur inconnue'
            }.`,
          );
        }
      }
    }

    return { wave, notified: selected.length, skipped: false };
  }

  /* Chargement ciblé en 2 requêtes (pas de N+1) : techniciens disponibles
   * (quel que soit leur KYC — la notification n'exige pas la vérification),
   * puis couvertures actives filtrées ville (GEO-04). Le `kycStatus` reste
   * sélectionné à titre informatif ; seul `acceptDemande` l'exige. */
  private async loadCandidates(): Promise<DispatchCandidate[]> {
    const technicians = await this.prisma.user.findMany({
      where: {
        role: 'TECHNICIAN',
        // Sprint ADMIN SUPER POWERS : un compte désactivé par l'admin ne
        // reçoit plus aucune mission (connexion déjà bloquée côté auth).
        isActive: true,
        technicianProfile: { isAvailable: true },
      },
      select: {
        id: true,
        email: true,
        technicianProfile: {
          select: {
            city: true,
            cityId: true,
            categories: true,
            isAvailable: true,
            kycStatus: true,
            zoneCoverages: {
              select: {
                zoneId: true,
                zone: { select: { isActive: true, cityId: true } },
              },
            },
          },
        },
      },
    });
    return technicians.flatMap((technician) => {
      const profile = technician.technicianProfile;
      if (!profile) return [];
      return [
        {
          userId: technician.id,
          email: technician.email,
          city: profile.city,
          cityId: profile.cityId,
          categories: profile.categories,
          isAvailable: profile.isAvailable,
          kycStatus: profile.kycStatus,
          coverageZoneIds: filterActiveCoverageZoneIdsForCity(profile.zoneCoverages, profile.cityId),
        },
      ];
    });
  }
}