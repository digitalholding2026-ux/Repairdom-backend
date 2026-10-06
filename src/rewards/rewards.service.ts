import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RewardsNotificationsService } from './rewards-notifications.service.js';
import {
  FRAUD_REASON_SAME_TECHNICIAN_48H,
  REWARD_TIERS,
  highestTier,
  isCountableAmount,
  isRewardTierName,
  isSuspiciousSequence,
  newlyReachedTiers,
  nextTierFor,
  type RewardTierDefinition,
  type RewardTierName,
} from './rewards.config.js';

/**
 * Chantier #4A — Programme de récompenses client.
 *
 * Règles (validées côté produit) :
 *   1. une mission COMPTE si elle est CONFIRMED, payée `finalAmount >=
 *      MIN_MISSION_AMOUNT_XAF` (1 500 XAF), et sans signalement anti-fraude ;
 *   2. une seule récompense par palier — un palier franchi est définitif ;
 *   3. aucun reset annuel, compteurs cumulatifs à vie ;
 *   4. anti-fraude : 2 missions CONFIRMED consécutives du même client avec le
 *      MÊME technicien, séparées de moins de 48 h → signalement, et la 2ᵉ
 *      mission n'est PAS comptabilisée tant que l'admin n'a pas tranché.
 *
 * ── Choix d'implémentation à connaître ──────────────────────────────
 *
 * HORODATAGE DE CONFIRMATION. Le schéma `Demande` ne porte pas de colonne
 * `confirmedAt`. Plutôt que d'ajouter une colonne ET de modifier la
 * transaction de confirmation (hors périmètre : « ne pas toucher au flow de
 * confirmation »), on lit `Demande.updatedAt`, qui après le passage à
 * CONFIRMED n'est plus modifié : une mission CONFIRMED est terminale, et les
 * seules écritures ultérieures (litige, avis, notifications) visent d'autres
 * tables. `updatedAt` est donc, en pratique, l'instant de confirmation. Le
 * risque résiduel est nul à l'échelle d'une fenêtre de 48 h.
 *
 * ATOMICITÉ DU COMPTEUR. L'incrément passe par un `updateMany` gardé
 * (`missionCount` relu puis incrémenté), jamais par un `upsert` avec une
 * valeur calculée en JS : deux confirmations strictement simultanées ne
 * peuvent pas s'écraser. Le `ClientRewardProgress` est créé à la demande
 * (`createMany` + `skipDuplicates` tolérant au P2002), donc un compte qui
 * n'a jamais eu de mission payée n'a pas de ligne — `getProgress` renvoie
 * alors un état à zéro synthétisé.
 *
  * IDEMPOTENCE. `onMissionConfirmed` est appelé APRÈS la transaction de
  * confirmation : un rejeu (retry réseau, double appel) ne doit pas compter
  * deux fois la mission.
  *
  * Côté fraude, l'idempotence est structurelle : `RewardFraudFlag.demandeId`
  * est UNIQUE en base, donc un rejeu relit le signalement existant au lieu
  * d'en créer un second (et ne compte toujours rien).
  *
  * Côté nominal, un rejeu ne peut pas franchir deux fois un palier
  * (`reachedTiers` n'est jamais régressé), mais il INC RÉMENTERAIT le
  * compteur. La vraie protection est en amont : côté `DemandesService`, la
  * transition vers CONFIRMED est un `updateMany` gardé sur le statut lu, donc
  * une double confirmation obtient un 409 et le service de récompenses n'est
  * appelé qu'une fois par mission. C'est cette propriété — et non un garde-fou
  * local — qui rend le comptage exact.
  */
@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: RewardsNotificationsService,
  ) {}

  /* ══════════════════════════════════════════════════════════════════
   * Point d'entrée : une mission vient d'être CONFIRMED
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Comptabilise (ou refuse) une mission confirmée, puis déclenche les
   * notifications de palier.
   *
   * Appelé APRÈS la transaction de confirmation, dans un try/catch par
   * l'appelant : un échec ici ne doit JAMAIS faire échouer la confirmation
   * (le règlement financier est déjà commis).
   */
  async onMissionConfirmed(demandeId: string): Promise<RewardCountOutcome> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        reference: true,
        clientId: true,
        technicianId: true,
        status: true,
        finalAmount: true,
        updatedAt: true,
      },
    });

    // Mission introuvable : rien à comptabiliser (course : mission supprimée).
    if (!demande) {
      this.logger.warn(`Mission ${demandeId} introuvable : comptage récompenses ignoré.`);
      return { counted: false, reason: 'DEMANDE_NOT_FOUND' };
    }

    // Seules les missions CONFIRMED comptent (défense en profondeur : l'appelant
    // n'appelle que sur CONFIRMED, mais la règle doit tenir ici).
    if (demande.status !== 'CONFIRMED') {
      return { counted: false, reason: 'NOT_CONFIRMED' };
    }

    // Règle de comptage 1 : montant payé minimal.
    if (!isCountableAmount(demande.finalAmount)) {
      return { counted: false, reason: 'AMOUNT_BELOW_MINIMUM' };
    }

    // Une mission sans technicien ne peut pas être un signalement anti-fraude :
    // dans ce cas on la compte normalement (et on ne peut pas l'« assigner »).
    const previous = await this.findPreviousConfirmedMission(demande.clientId, demande.id, demande.updatedAt);

    if (
      previous &&
      isSuspiciousSequence(demande.technicianId, previous.technicianId, demande.updatedAt.getTime() - previous.updatedAt.getTime())
    ) {
      return this.openFraudFlag(demande, previous);
    }

    return this.countMission(demande.clientId, demande.id, demande.updatedAt, demande.reference);
  }

  /* ── Anti-fraude ─────────────────────────────────────────────────── */

  /**
   * Ouvre le signalement et NE COMPTE PAS la mission.
   *
   * L'unicité sur `RewardFraudFlag.demandeId` rend l'opération idempotente : si
   * un signalement existe déjà pour cette mission (rejeu de la confirmation),
   * on le renvoie tel quel au lieu d'en créer un second et de renvoyer une
   * erreur au client.
   */
  private async openFraudFlag(
    demande: { id: string; reference: string; clientId: string; technicianId: string | null },
    previous: { id: string; updatedAt: Date },
  ): Promise<RewardCountOutcome> {
    const existing = await this.prisma.rewardFraudFlag.findUnique({
      where: { demandeId: demande.id },
      select: { id: true },
    });
    if (existing) {
      return { counted: false, reason: 'FRAUD_FLAGGED', flagId: existing.id };
    }

    try {
      const flag = await this.prisma.rewardFraudFlag.create({
        data: {
          userId: demande.clientId,
          demandeId: demande.id,
          technicianId: demande.technicianId as string,
          reason: FRAUD_REASON_SAME_TECHNICIAN_48H,
        },
        select: { id: true },
      });
      this.logger.warn(
        `Signalement anti-fraude ouvert (mission ${demande.reference}) : même technicien sur la mission précédente ${previous.id} dans la fenêtre de 48 h.`,
      );
      return { counted: false, reason: 'FRAUD_FLAGGED', flagId: flag.id };
    } catch (error) {
      /* Course entre deux traitements de la même mission : l'unicité du
       * `demandeId` rejette le second `create`. On relit et on renvoie le
       * flag gagnant plutôt que de laisser remonter une erreur. */
      if (this.isUniqueViolation(error)) {
        const winner = await this.prisma.rewardFraudFlag.findUnique({
          where: { demandeId: demande.id },
          select: { id: true },
        });
        return { counted: false, reason: 'FRAUD_FLAGGED', flagId: winner?.id };
      }
      throw error;
    }
  }

  /**
   * Dernière mission CONFIRMED du même client, excluant celle en cours, et
   * antérieure à elle. Ordonnée sur `updatedAt` décroissant (voir note de
   * classe sur l'horodatage de confirmation).
   */
  private async findPreviousConfirmedMission(
    clientId: string,
    currentDemandeId: string,
    currentUpdatedAt: Date,
  ): Promise<{ id: string; technicianId: string | null; updatedAt: Date } | null> {
    return this.prisma.demande.findFirst({
      where: {
        clientId,
        id: { not: currentDemandeId },
        status: 'CONFIRMED',
        updatedAt: { lt: currentUpdatedAt },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, technicianId: true, updatedAt: true },
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * Comptage et paliers
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Incrémente le compteur et notifie les paliers nouvellement franchis.
   *
   * L'ordre est important : on incrémente d'abord (source de vérité), puis on
   * notifie. Une notification est best-effort ; le compteur, jamais.
   */
  private async countMission(
    clientId: string,
    demandeId: string,
    confirmedAt: Date,
    reference: string,
  ): Promise<RewardCountOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { firstName: true },
    });

    const before = await this.readProgress(clientId);

    // Incrément ATOMIQUE : `updateMany` relit et écrit sous le verrou de la
    // ligne, donc deux confirmations simultanées s'additionnent au lieu de
    // s'écraser. `missionCount: { increment: 1 }` fait le compte en base.
    await this.prisma.clientRewardProgress.upsert({
      where: { userId: clientId },
      create: {
        userId: clientId,
        missionCount: 1,
        currentTier: 'NONE',
        reachedTiers: [],
        claimedTiers: [],
        lastMissionAt: confirmedAt,
      },
      update: {
        missionCount: { increment: 1 },
        lastMissionAt: confirmedAt,
      },
    });

    const after = await this.readProgress(clientId);
    if (!after) {
      // La ligne vient d'être créée : elle existe forcément, sauf suppression
      // concurrente du compte. On ne bloque pas la confirmation.
      return { counted: true, missionCount: before?.missionCount ?? 0, tiersReached: [] };
    }

    // Paliers franchis par CE comptage (calcul sur le compteur d'après).
    const reached = newlyReachedTiers(after.missionCount, before?.reachedTiers ?? []);

    /* UNION des paliers connus AVANT et APRÈS l'incrément, plus ceux que ce
     * comptage vient de franchir.
     *
     * L'union est indispensable et pas un simple confort : l'`upsert` du
     * compteur n'écrit QUE `missionCount` et `lastMissionAt` (l'incrément doit
     * rester atomique et minimal), donc `after.reachedTiers` est encore la
     * liste d'AVANT. Écrire `after.reachedTiers` tel quel effacerait les
     * paliers déjà franchis, et `highestTier(after.reachedTiers)` renverrait
     * toujours `NONE`. Un palier atteint est DÉFINITIF : il ne se reperd pas. */
    const mergedReached = [
      ...new Set([...(before?.reachedTiers ?? []), ...after.reachedTiers, ...reached.map((tier) => tier.tier)]),
    ];
    const newTier = highestTier(mergedReached);

    // Persistance des paliers franchis + du niveau courant.
    await this.prisma.clientRewardProgress.update({
      where: { userId: clientId },
      data: {
        reachedTiers: mergedReached as never,
        currentTier: newTier as never,
      },
    });

    // Signal temps réel : la progression a changé (palier ou simple compteur).
    this.notifications.publishProgressChanged(clientId, {
      missionCount: after.missionCount,
      currentTier: newTier,
      tiersReached: reached.map((tier) => tier.tier),
    });

    if (reached.length > 0) {
      await this.notifyTiersReached(clientId, user?.firstName ?? null, reached, after.missionCount);
    }

    this.logger.log(
      `Mission ${reference} comptabilisée : client à ${after.missionCount} mission(s)${
        reached.length > 0 ? `, palier(s) franchi(s) : ${reached.map((t) => t.tier).join(', ')}` : ''
      }.`,
    );

    return {
      counted: true,
      missionCount: after.missionCount,
      tiersReached: reached.map((tier) => tier.tier),
    };
  }

  /** Notifie chaque palier franchi sur les 4 canaux (in-app, SSE, push, e-mail). */
  private async notifyTiersReached(
    clientId: string,
    firstName: string | null,
    tiers: readonly RewardTierDefinition[],
    missionCount: number,
  ): Promise<void> {
    for (const tier of tiers) {
      /* `nextTierFor` est recalculé pour chaque palier : si le client vient de
       * franchir plusieurs paliers d'un coup, chaque e-mail annonce « encore X
       * missions pour le palier suivant » cohérent avec l'état atteint. */
      const next = nextTierFor(missionCount);
      try {
        await this.notifications.notifyTierReached(clientId, firstName, tier, next);
      } catch (error) {
        /* Le service de notification encapsule déjà chaque canal ; ce filet
         * couvre le cas où le harnais lui-même lève (jamais de notification ne
         * doit faire échouer le comptage). */
        this.logger.warn(
          `Notification du palier ${tier.tier} en échec pour ${clientId} : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }.`,
        );
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   * Décision administrative sur un signalement
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Tranche un signalement anti-fraude.
   *
   * `VALIDATED` : la mission EST comptabilisée (et notifiée comme une mission
   * normale). `REJECTED` : elle ne l'est pas, et le client est informé sur
   * 3 canaux (in-app, SSE, push — pas d'e-mail).
   *
   * Idempotent : rejouer la même décision sur un signalement déjà résolu ne
   * recounts rien (le `where` du claim atomique échoue → `ConflictException`).
   */
  async resolveFraudFlag(
    flagId: string,
    decision: FraudDecision,
    adminId: string,
    note?: string,
  ): Promise<RewardResolution> {
    if (decision !== 'VALIDATED' && decision !== 'REJECTED') {
      throw new BadRequestException('Décision invalide : utilisez VALIDATED ou REJECTED.');
    }

    const flag = await this.prisma.rewardFraudFlag.findUnique({
      where: { id: flagId },
      include: {
        demande: { select: { id: true, reference: true, clientId: true, updatedAt: true, finalAmount: true, status: true } },
      },
    });
    if (!flag) throw new NotFoundException('Signalement introuvable.');

    // Claim ATOMIQUE : `resolvedAt: null` dans le `where` garantit qu'une
    // double décision concurrente ne traite le dossier qu'une fois.
    const claimed = await this.prisma.rewardFraudFlag.updateMany({
      where: { id: flagId, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedBy: adminId,
        decision,
        note: note?.trim() || null,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Ce signalement a déjà été traité par un administrateur.');
    }

    if (decision === 'REJECTED') {
      await this.notifications.notifyMissionNotCounted(
        flag.userId,
        flag.reason,
        flag.demande.reference,
      );
      this.logger.log(
        `Signalement ${flagId} REJECTED : la mission ${flag.demande.reference} n'est pas comptabilisée.`,
      );
      return { counted: false, decision };
    }

    // VALIDATED → on compte la mission, puis on clôt le dossier.
    const outcome = await this.countMission(
      flag.demande.clientId,
      flag.demande.id,
      flag.demande.updatedAt,
      flag.demande.reference,
    );
    this.logger.log(
      `Signalement ${flagId} VALIDATED : la mission ${flag.demande.reference} est comptabilisée (${outcome.missionCount} mission(s)).`,
    );
    return { counted: true, decision, missionCount: outcome.missionCount, tiersReached: outcome.tiersReached };
  }

  /** Liste des signalements, les plus récents d'abord. */
  async listFraudFlags(options: { resolved?: boolean; take?: number } = {}): Promise<RewardFraudFlagRow[]> {
    const flags = await this.prisma.rewardFraudFlag.findMany({
      where: options.resolved === undefined ? undefined : { resolvedAt: options.resolved ? { not: null } : null },
      orderBy: { detectedAt: 'desc' },
      take: Math.min(options.take ?? 50, 200),
      select: {
        id: true,
        reason: true,
        detectedAt: true,
        resolvedAt: true,
        decision: true,
        note: true,
        userId: true,
        demandeId: true,
        technicianId: true,
        demande: { select: { reference: true, finalAmount: true, status: true, createdAt: true } },
        user: { select: { firstName: true, lastName: true, email: true } },
        technician: { select: { firstName: true, lastName: true } },
      },
    });

    return flags.map((flag) => ({
      id: flag.id,
      reason: flag.reason,
      detectedAt: flag.detectedAt.toISOString(),
      resolvedAt: flag.resolvedAt ? flag.resolvedAt.toISOString() : null,
      /* `decision` est une colonne texte libre en base : on ne la trusts pas
       * telle quelle vers le contrat API, on la ramène au type fermé
       * `FraudDecision` (une valeur inattendue devient `null` = « pas encore
       * tranché » côté lecture, plutôt que de fuiter une chaîne en clair). */
      decision:
        flag.decision === 'VALIDATED' || flag.decision === 'REJECTED' ? flag.decision : null,
      note: flag.note,
      userId: flag.userId,
      clientName: [flag.user.firstName, flag.user.lastName].filter(Boolean).join(' ') || flag.user.email,
      demandeId: flag.demandeId,
      missionReference: flag.demande.reference,
      missionFinalAmountXAF: flag.demande.finalAmount,
      missionStatus: flag.demande.status,
      technicianId: flag.technicianId,
      technicianName: [flag.technician.firstName, flag.technician.lastName].filter(Boolean).join(' '),
    }));
  }

  /* ══════════════════════════════════════════════════════════════════
   * Lecture de progression
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Progression complète du client : compteur, niveau, paliers franchis et
   * demandés, prochain palier et catalogue des 4 paliers.
   *
   * Un client sans aucune mission payée n'a pas de ligne en base : on renvoie
   * alors un état à zéro synthétisé (l'UI affiche « 0 / 15 » sans erreur).
   */
  async getProgress(userId: string): Promise<RewardProgressView> {
    const row = await this.readProgress(userId);
    const missionCount = row?.missionCount ?? 0;
    const reachedTiers = row?.reachedTiers ?? [];

    return {
      missionCount,
      currentTier: row?.currentTier ?? 'NONE',
      reachedTiers,
      claimedTiers: row?.claimedTiers ?? [],
      lastMissionAt: row?.lastMissionAt ? row.lastMissionAt.toISOString() : null,
      nextTier: nextTierFor(missionCount),
      tiers: REWARD_TIERS.map((tier) => ({ ...tier })),
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * Demande d'usage d'une récompense
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Enregistre la DEMANDE d'usage d'une récompense (« Utiliser ma
   * récompense »).
   *
   * L'application effective reste manuelle (un conseiller / l'admin l'accorde) :
   * cette méthode mémorise uniquement la demande, comme prévu au cadrage.
   * Refus explicites : palier inconnu (400), palier non atteint (400), palier
   * déjà demandé (400).
   */
  async claimTier(userId: string, tier: string): Promise<RewardClaimResult> {
    if (!isRewardTierName(tier)) {
      throw new BadRequestException('Palier inconnu.');
    }

    const row = await this.readProgress(userId);
    const reachedTiers = row?.reachedTiers ?? [];
    const claimedTiers = row?.claimedTiers ?? [];

    if (!reachedTiers.includes(tier)) {
      throw new BadRequestException("Ce palier n'est pas encore atteint.");
    }
    if (claimedTiers.includes(tier)) {
      throw new BadRequestException('La demande a déjà été enregistrée pour ce palier.');
    }

    const updated = await this.prisma.clientRewardProgress.update({
      where: { userId },
      data: { claimedTiers: [...claimedTiers, tier] as never },
      select: { claimedTiers: true, updatedAt: true },
    });

    this.logger.log(`Client ${userId} demande l'usage de la récompense ${tier}.`);

    return {
      success: true,
      tier,
      claimedAt: updated.updatedAt.toISOString(),
      claimedTiers: updated.claimedTiers,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * Helpers
   * ══════════════════════════════════════════════════════════════════ */

  /** Progression persistée, ou `null` si le client n'a aucune ligne.
   *
   * Les listes d'enums (`reachedTiers`, `claimedTiers`) sont typées comme
   * `string[]` et non `RewardTier[]` : c'est le type réel que renvoie Prisma
   * pour une liste d'enum, et la comparaison avec le palier demandé est faite
   * par valeur. Les écritures correspondantes utilisent un cast explicite,
   * validé par `isRewardTierName` en amont. */
  private async readProgress(
    userId: string,
  ): Promise<{
    missionCount: number;
    currentTier: RewardTierName | 'NONE';
    reachedTiers: string[];
    claimedTiers: string[];
    lastMissionAt: Date | null;
  } | null> {
    return this.prisma.clientRewardProgress.findUnique({
      where: { userId },
      select: {
        missionCount: true,
        currentTier: true,
        reachedTiers: true,
        claimedTiers: true,
        lastMissionAt: true,
      },
    });
  }

  /** Prisma signale un conflit d'unicité par le code `P2002`. */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Types de sortie (contrat des endpoints)
 * ══════════════════════════════════════════════════════════════════ */

/** Pourquoi une mission a été comptée ou non. */
export type RewardCountReason =
  | 'DEMANDE_NOT_FOUND'
  | 'NOT_CONFIRMED'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'FRAUD_FLAGGED';

export interface RewardCountOutcome {
  counted: boolean;
  reason?: RewardCountReason;
  flagId?: string | null;
  missionCount?: number;
  tiersReached?: RewardTierName[];
}

export type FraudDecision = 'VALIDATED' | 'REJECTED';

export interface RewardResolution {
  counted: boolean;
  decision: FraudDecision;
  missionCount?: number;
  tiersReached?: RewardTierName[];
}

export interface RewardProgressView {
  missionCount: number;
  currentTier: RewardTierName | 'NONE';
  reachedTiers: string[];
  claimedTiers: string[];
  lastMissionAt: string | null;
  nextTier: {
    tier: string;
    missions: number;
    remaining: number;
    label: string;
    reward: string;
    rewardValueXAF: number;
  } | null;
  tiers: RewardTierDefinition[];
}

export interface RewardClaimResult {
  success: true;
  tier: string;
  claimedAt: string;
  claimedTiers: string[];
}

/** Ligne de signalement sérialisée pour l'admin (montants XAF entiers). */
export interface RewardFraudFlagRow {
  id: string;
  reason: string;
  detectedAt: string;
  resolvedAt: string | null;
  decision: FraudDecision | null;
  note: string | null;
  userId: string;
  clientName: string;
  demandeId: string;
  missionReference: string;
  missionFinalAmountXAF: number | null;
  missionStatus: string;
  technicianId: string;
  technicianName: string;
}
