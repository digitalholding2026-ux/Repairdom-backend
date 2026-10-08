import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RewardsNotificationsService } from './rewards-notifications.service.js';
import { calculateTechnicianFee } from '../financial/fee-calculator.js';
import {
  CREDIT_PER_TRANCHE_XAF,
  CREDIT_TRANCHE_XAF,
  FRAUD_REASON_SAME_TECHNICIAN_48H,
  NATURE_THRESHOLDS,
  NATURE_TIER_NAMES,
  REWARD_TIER_NAMES,
  TIER_THRESHOLDS,
  creditsAvailable,
  creditsEarnedForMargin,
  isCountableAmount,
  isNatureTierName,
  isSuspiciousSequence,
  marginToNextCredit,
  natureTierForMargin,
  newlyReachedNature,
  newlyReachedTiers,
  nextCreditTrancheAt,
  nextNatureThreshold,
  nextTierThreshold,
  tierForMargin,
  type NatureTierName,
  type RewardTierName,
} from './rewards.config.js';

/**
 * Chantier 4-FONDATIONS-C — Programme de fidélité LTV.
 *
 * L'unité de progression n'est plus la mission mais la **marge cumulée** : à
 * chaque mission CONFIRMED, on cumule la commission Relio prélevée sur cette
 * mission. Le coût du programme est donc borné à 5 % de la marge à vie
 * (voir `rewards.config.ts`).
 *
 * Règles :
 *   1. une mission COMPTE si elle est CONFIRMED, payée
 *      `finalAmount >= MIN_MISSION_AMOUNT_XAF`, avec un devis ACCEPTED (c'est
 *      le devis qui porte la commission), et sans signalement anti-fraude ;
 *   2. un palier atteint est DÉFINITIF, la marge est cumulative à vie ;
 *   3. les crédits s'accumulent et attendent une demande explicite du client ;
 *   4. les récompenses nature sont cumulables et doivent être réclamées ;
 *   5. anti-fraude (inchangé depuis le #4A) : 2 missions CONFIRMED consécutives
 *      du même client avec le MÊME technicien en moins de 48 h → signalement,
 *      et la 2ᵉ mission n'est PAS comptabilisée tant que l'admin n'a pas
 *      tranché.
 *
 * ── Choix d'implémentation à connaître ──────────────────────────────
 *
 * MARGE = COMMISSION, PAS `finalAmount`. `Demande.finalAmount` vaut
 * « réparation + transport » : c'est ce que paie le client, pas ce que Relio
 * garde. La marge est donc `calculateTechnicianFee(devis.amount)` — la même
 * fonction qui alimente l'écriture ledger `TECHNICIAN_FEE` au règlement, donc
 * la progression ne peut pas diverger de la comptabilité. (Le chantier
 * 4-FONDATIONS-A a remplacé l'ancien `computeRelioCommission` par
 * `calculateTechnicianFee` : c'est cette dernière qui fait foi.)
 *
 * HORODATAGE DE CONFIRMATION. Le schéma `Demande` ne porte pas de colonne
 * `confirmedAt` et le flow de confirmation est hors périmètre : on lit
 * `Demande.updatedAt`, qui n'est plus modifié après CONFIRMED (une mission
 * confirmée est terminale ; les écritures ultérieures visent d'autres
 * tables). Le risque résiduel est nul à l'échelle d'une fenêtre de 48 h.
 *
 * ATOMICITÉ. La marge est incrémentée par un `updateMany` gardé (`increment`),
 * jamais par un `upsert` à valeur calculée en JS : deux confirmations
 * strictement simultanées ne peuvent pas s'écraser. Le libellé de la ligne de
 * progression est ensuite persisté par un `update` séparé et minimal.
 *
 * IDEMPOTENCE. `onMissionConfirmed` est appelé APRÈS la transaction de
 * confirmation : un rejeu ne doit pas compter deux fois la mission. La
 * protection réelle est en amont — côté `DemandesService`, la transition vers
 * CONFIRMED est un `updateMany` gardé sur le statut lu, donc une double
 * confirmation obtient un 409 et ce service n'est appelé qu'une fois.
 *
 * CÔTÉ FRAUDE. L'idempotence y est structurelle :
 * `RewardFraudFlag.demandeId` est UNIQUE en base, donc un rejeu relit le
 * signalement existant au lieu d'en créer un second.
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
   * Cumulule la marge de la mission, puis déclenche les notifications
   * (crédit, badge, palier nature).
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

    if (!demande) {
      this.logger.warn(`Mission ${demandeId} introuvable : cumul de marge ignoré.`);
      return { counted: false, reason: 'DEMANDE_NOT_FOUND' };
    }

    if (demande.status !== 'CONFIRMED') {
      return { counted: false, reason: 'NOT_CONFIRMED' };
    }

    if (!isCountableAmount(demande.finalAmount)) {
      return { counted: false, reason: 'AMOUNT_BELOW_MINIMUM' };
    }

    /* La commission est celle du devis ACCEPTÉ. Sans devis accepté, il n'y a
     * pas de commission prélevée : rien à cumuler. */
    const quote = await this.prisma.quote.findFirst({
      where: { demandeId, status: 'ACCEPTED' },
      select: { id: true, amount: true },
    });
    if (!quote) {
      return { counted: false, reason: 'NO_ACCEPTED_QUOTE' };
    }

    const marginXAF = calculateTechnicianFee(quote.amount);
    if (marginXAF <= 0) {
      return { counted: false, reason: 'AMOUNT_BELOW_MINIMUM' };
    }

    // Une mission sans technicien ne peut pas être un signalement anti-fraude.
    const previous = await this.findPreviousConfirmedMission(
      demande.clientId,
      demande.id,
      demande.updatedAt,
    );

    if (
      previous &&
      isSuspiciousSequence(
        demande.technicianId,
        previous.technicianId,
        demande.updatedAt.getTime() - previous.updatedAt.getTime(),
      )
    ) {
      return this.openFraudFlag(demande, previous);
    }

    return this.accumulateMargin(
      {
        id: demande.id,
        reference: demande.reference,
        clientId: demande.clientId,
        updatedAt: demande.updatedAt,
      },
      marginXAF,
    );
  }

  /* ── Anti-fraude ─────────────────────────────────────────────────── */

  /**
   * Ouvre le signalement et NE COMPTE PAS la mission.
   *
   * L'unicité sur `RewardFraudFlag.demandeId` rend l'opération idempotente.
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

  /** Dernière mission CONFIRMED du même client, excluant celle en cours. */
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
   * Cumul de marge et détection des paliers
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Incrémente la marge, puis notifie crédit / badge / nature.
   *
   * L'ordre est important : on incrémente d'abord (source de vérité), puis on
   * notifie. Une notification est best-effort ; la marge, jamais.
   */
  private async accumulateMargin(
    demande: { id: string; reference: string; clientId: string; updatedAt: Date },
    marginXAF: number,
  ): Promise<RewardCountOutcome> {
    const confirmedAt = demande.updatedAt;
    const clientId = demande.clientId;

    const user = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { firstName: true },
    });

    const before = await this.readProgress(clientId);

    /* Incrément ATOMIQUE : `increment` fait le calcul en base, sous le verrou
     * de la ligne. Deux confirmations simultanées s'additionnent au lieu de
     * s'écraser. La ligne est créée à la demande avec les valeurs déjà
     * cohérentes pour une PREMIÈRE mission. */
    await this.prisma.clientRewardProgress.upsert({
      where: { userId: clientId },
      create: {
        userId: clientId,
        cumulativeMarginXAF: marginXAF,
        creditsEarned: creditsEarnedForMargin(marginXAF),
        currentTier: tierForMargin(marginXAF) as never,
        currentNatureTier: natureTierForMargin(marginXAF) as never,
        natureReached: newlyReachedNature(marginXAF, []).map((tier) => tier.tier) as never,
        lastMissionAt: confirmedAt,
      },
      update: {
        cumulativeMarginXAF: { increment: marginXAF },
        lastMissionAt: confirmedAt,
      },
    });

    const after = await this.readProgress(clientId);
    if (!after) {
      // La ligne vient d'être créée : elle existe forcément sauf suppression
      // concurrente du compte. On ne bloque pas la confirmation.
      return { counted: true, cumulativeMarginXAF: marginXAF, creditsEarned: 0 };
    }

    const marginAfter = after.cumulativeMarginXAF;

    // Crédits : dérivés de la marge, jamais incrémentés à la main.
    const earnedAfter = creditsEarnedForMargin(marginAfter);
    const earnedBefore = before?.creditsEarned ?? 0;
    const newlyEarnedXAF = Math.max(earnedAfter - earnedBefore, 0);

    // Badges franchis par CE cumul.
    /* `already` = les badges DÉJÀ atteints (`currentTierList`), et NON la
     * liste nature : se tromper ici ferait re-notifier un palier déjà franchi
     * à chaque mission suivante. */
    const reachedTiers = newlyReachedTiers(marginAfter, before?.currentTierList ?? []);
    /* Union des paliers connus AVANT et APRÈS : l'`upsert` n'écrit QUE la
     * marge et `lastMissionAt` (l'incrément doit rester atomique et minimal),
     * donc `after` porte encore la liste d'AVANT. Un palier atteint est
     * DÉFINITIF : il ne se reperd pas. */
    const mergedTiers = [
      ...new Set([...(before?.currentTierList ?? []), after.currentTierList, ...reachedTiers.map((t) => t.tier)]),
    ].filter((tier): tier is string => tier !== 'NONE');

    const newTier = tierForMargin(marginAfter);

    // Paliers nature cumulables.
    const reachedNature = newlyReachedNature(marginAfter, before?.natureReached ?? []);
    const mergedNature = [
      ...new Set([...(before?.natureReached ?? []), ...after.natureReached, ...reachedNature.map((t) => t.tier)]),
    ];

    await this.prisma.clientRewardProgress.update({
      where: { userId: clientId },
      data: {
        creditsEarned: earnedAfter,
        currentTier: newTier as never,
        currentNatureTier: natureTierForMargin(marginAfter) as never,
        natureReached: mergedNature as NatureTierName[],
      },
    });

    // Signal temps réel : la progression a changé.
    this.notifications.publishProgressChanged(clientId, {
      cumulativeMarginXAF: marginAfter,
      creditsAvailable: creditsAvailable(earnedAfter, after.creditsClaimed),
      tierReached: newTier,
    });

    if (newlyEarnedXAF > 0) {
      await this.notifySafely(clientId, 'crédit', () =>
        this.notifications.notifyCreditsEarned(clientId, newlyEarnedXAF),
      );
    }

    if (reachedTiers.length > 0) {
      for (const tier of reachedTiers) {
        await this.notifySafely(clientId, `badge ${tier.tier}`, () =>
          this.notifications.notifyTierReached(
            clientId,
            user?.firstName ?? null,
            tier,
            nextTierThreshold(marginAfter),
          ),
        );
      }
    }

    if (reachedNature.length > 0) {
      for (const tier of reachedNature) {
        await this.notifySafely(clientId, `nature ${tier.tier}`, () =>
          this.notifications.notifyNatureReached(clientId, tier),
        );
      }
    }

    this.logger.log(
      `Mission ${demande.reference} comptabilisée : marge +${marginXAF} XAF, cumul ${marginAfter} XAF, ` +
        `crédits ${earnedAfter} XAF${newlyEarnedXAF > 0 ? ` (+${newlyEarnedXAF})` : ''}` +
        `${mergedTiers.length > 0 ? `, badge(s) : ${mergedTiers.join(', ')}` : ''}.`,
    );

    return {
      counted: true,
      marginXAF,
      cumulativeMarginXAF: marginAfter,
      creditsEarned: earnedAfter,
      tiersReached: mergedTiers as RewardTierName[],
      natureReached: mergedNature as NatureTierName[],
    };
  }

  /** Aucun canal de notification ne doit faire échouer le cumul de marge. */
  private async notifySafely(
    clientId: string,
    what: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(
        `Notification « ${what} » en échec pour ${clientId} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }. La progression est conservée.`,
      );
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   * Crédits : versement au solde
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Verse les crédits DISPONIBLES au solde du client.
   *
   * Le versement est une écriture de ledger `CLIENT_REWARD_CREDIT` (CREDIT) —
   * distincte de `CLIENT_TOPUP`, qui est une vraie recharge payante : ici
   * aucun encaissement n'a lieu, c'est un avantage acquis par la marge
   * cumulée. Le solde du client est TOUJOURS recalculé depuis le ledger
   * (`ledgerBalance`), donc l'écriture suffit à le créditer.
   *
   * La référence est déterministe et UNIQUE en base : un double appel ne crée
   * pas de double versement (le `P2002` est absorbé et l'état renvoyé est
   * simplement inchangé).
   */
  async claimCredits(userId: string): Promise<CreditsClaimResult> {
    const row = await this.readProgress(userId);
    const earned = row?.creditsEarned ?? 0;
    const claimed = row?.creditsClaimed ?? 0;
    const available = creditsAvailable(earned, claimed);

    if (available <= 0) {
      throw new BadRequestException('Aucun crédit disponible.');
    }

    const now = new Date();
    const reference = `reward-credit:${userId}`;

    const result = await this.prisma.$transaction(async (tx) => {
      // 1) Écriture ledger (idempotente par `reference` UNIQUE).
      try {
        await tx.financialTransaction.create({
          data: {
            userId,
            demandeId: null,
            type: 'CLIENT_REWARD_CREDIT',
            direction: 'CREDIT',
            amount: available,
            status: 'VALIDATED',
            mode: this.currentMode(),
            reference,
            createdById: userId,
            metadata: {
              creditsEarned: earned,
              creditsClaimedBefore: claimed,
              credited: available,
              trancheXAF: CREDIT_TRANCHE_XAF,
              creditPerTrancheXAF: CREDIT_PER_TRANCHE_XAF,
              currency: 'XAF',
            },
          },
        });
      } catch (error) {
        /* Versement déjà effectué (rejeu) : on ne double pas. */
        if (!this.isUniqueViolation(error)) throw error;
      }

      // 2) Claim ATOMIQUE : le `where` porte la valeur lue, donc deux
      // réclamations simultanées ne créditent qu'une fois le même disponible.
      const updated = await tx.clientRewardProgress.updateMany({
        where: { userId, creditsEarned: earned, creditsClaimed: claimed },
        data: { creditsClaimed: earned, lastCreditClaimAt: now },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Un autre versement de crédits est en cours. Réessayez.');
      }

      const balance = await tx.financialTransaction.aggregate({
        where: { userId, status: 'VALIDATED', direction: 'CREDIT' },
        _sum: { amount: true },
      });
      const debits = await tx.financialTransaction.aggregate({
        where: { userId, status: 'VALIDATED', direction: 'DEBIT' },
        _sum: { amount: true },
      });

      return {
        claimedXAF: available,
        newBalanceXAF: (balance._sum.amount ?? 0) - (debits._sum.amount ?? 0),
        creditsEarned: earned,
      };
    });

    this.notifications.publishProgressChanged(userId, {
      creditsAvailable: 0,
      creditsClaimed: result.claimedXAF,
    });

    this.logger.log(
      `Client ${userId} a versé ${result.claimedXAF} XAF de crédits de fidélité (marge cumulée ${
        row?.cumulativeMarginXAF ?? 0
      } XAF).`,
    );

    return {
      claimedXAF: result.claimedXAF,
      newBalanceXAF: result.newBalanceXAF,
      creditsEarned: result.creditsEarned,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * Récompenses nature : demande de versement (manuelle)
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Enregistre la DEMANDE de versement d'une récompense nature.
   *
   * Le versement effectif reste MANUEL (un conseiller / l'admin l'accorde) :
   * cette méthode mémorise la demande et prévient l'admin, comme le faisait
   * `claimTier` pour le #4A. Refus explicites : palier inconnu (400), palier
   * non atteint (400), palier déjà réclamé (400).
   */
  async claimNatureReward(userId: string, tier: string): Promise<NatureClaimResult> {
    const normalized = tier.trim().toUpperCase();
    if (!isNatureTierName(normalized)) {
      throw new BadRequestException(
        `Récompense inconnue. Valeurs acceptées : ${NATURE_TIER_NAMES.join(', ')}.`,
      );
    }

    const row = await this.readProgress(userId);
    const reached = row?.natureReached ?? [];
    const claimed = row?.natureClaimed ?? [];

    if (!reached.includes(normalized)) {
      throw new BadRequestException("Cette récompense n'est pas encore atteinte.");
    }
    if (claimed.includes(normalized)) {
      throw new BadRequestException('La demande a déjà été enregistrée pour cette récompense.');
    }

    const updated = await this.prisma.clientRewardProgress.update({
      where: { userId },
      data: { natureClaimed: [...claimed, normalized] as never },
      select: { natureClaimed: true, updatedAt: true, cumulativeMarginXAF: true },
    });

    await this.notifySafely(userId, `demande nature ${normalized}`, () =>
      this.notifications.notifyNatureClaimed(userId, normalized, NATURE_THRESHOLDS.find(
        (t) => t.tier === normalized,
      )!),
    );

    this.notifications.publishProgressChanged(userId, { natureClaimed: normalized });

    this.logger.log(`Client ${userId} réclame la récompense nature ${normalized}.`);

    return {
      success: true,
      tier: normalized,
      claimedAt: updated.updatedAt.toISOString(),
      natureClaimed: updated.natureClaimed,
      cumulativeMarginXAF: updated.cumulativeMarginXAF,
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * Décision administrative sur un signalement
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Tranche un signalement anti-fraude.
   *
   * `VALIDATED` : la mission EST comptabilisée. `REJECTED` : elle ne l'est pas,
   * et le client est informé (3 canaux, pas d'e-mail).
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
        demande: {
          select: {
            id: true,
            reference: true,
            clientId: true,
            updatedAt: true,
            finalAmount: true,
            status: true,
          },
        },
      },
    });
    if (!flag) throw new NotFoundException('Signalement introuvable.');

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

    // VALIDATED → on recompte la mission avec SA commission.
    const quote = await this.prisma.quote.findFirst({
      where: { demandeId: flag.demande.id, status: 'ACCEPTED' },
      select: { amount: true },
    });
    const marginXAF = quote ? calculateTechnicianFee(quote.amount) : 0;

    if (marginXAF <= 0) {
      this.logger.log(
        `Signalement ${flagId} VALIDATED mais aucun devis accepté : marge nulle, rien à cumuler.`,
      );
      return { counted: false, decision };
    }

    const outcome = await this.accumulateMargin(
      {
        id: flag.demande.id,
        reference: flag.demande.reference,
        clientId: flag.demande.clientId,
        updatedAt: flag.demande.updatedAt,
      },
      marginXAF,
    );
    this.logger.log(
      `Signalement ${flagId} VALIDATED : la mission ${flag.demande.reference} est comptabilisée (+${marginXAF} XAF).`,
    );
    return { counted: true, decision, marginXAF, cumulativeMarginXAF: outcome.cumulativeMarginXAF };
  }

  /** Liste des signalements, les plus récents d'abord. */
  async listFraudFlags(options: { resolved?: boolean; take?: number } = {}): Promise<RewardFraudFlagRow[]> {
    const flags = await this.prisma.rewardFraudFlag.findMany({
      where:
        options.resolved === undefined
          ? undefined
          : { resolvedAt: options.resolved ? { not: null } : null },
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
      /* `decision` est une colonne texte libre : on la ramène au type fermé
       * plutôt que de fuiter une chaîne inattendue vers le contrat API. */
      decision:
        flag.decision === 'VALIDATED' || flag.decision === 'REJECTED' ? flag.decision : null,
      note: flag.note,
      userId: flag.userId,
      clientName:
        [flag.user.firstName, flag.user.lastName].filter(Boolean).join(' ') || flag.user.email,
      demandeId: flag.demandeId,
      missionReference: flag.demande.reference,
      missionFinalAmountXAF: flag.demande.finalAmount,
      missionStatus: flag.demande.status,
      technicianId: flag.technicianId,
      technicianName: [flag.technician.firstName, flag.technician.lastName]
        .filter(Boolean)
        .join(' '),
    }));
  }

  /* ══════════════════════════════════════════════════════════════════
   * Lecture de progression
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Progression complète du client : marge cumulée, badges, nature, crédits.
   *
   * Un client sans aucune mission comptabilisée n'a pas de ligne en base : on
   * renvoie alors un état à zéro synthétisé (l'UI affiche « 0 XAF » sans
   * erreur).
   */
  async getProgress(userId: string): Promise<RewardProgressView> {
    const row = await this.readProgress(userId);
    const margin = row?.cumulativeMarginXAF ?? 0;
    const earned = row?.creditsEarned ?? 0;
    const claimed = row?.creditsClaimed ?? 0;

    return {
      cumulativeMarginXAF: margin,
      currentTier: row?.currentTier ?? 'NONE',
      currentNatureTier: row?.currentNatureTier ?? 'NONE',
      creditsEarned: earned,
      creditsClaimed: claimed,
      creditsAvailable: creditsAvailable(earned, claimed),
      natureReached: (row?.natureReached ?? []) as NatureTierName[],
      natureClaimed: (row?.natureClaimed ?? []) as NatureTierName[],
      reachedTiers: row?.currentTierList.filter((tier) => tier !== 'NONE') ?? [],
      lastMissionAt: row?.lastMissionAt ? row.lastMissionAt.toISOString() : null,
      lastCreditClaimAt: row?.lastCreditClaimAt ? row.lastCreditClaimAt.toISOString() : null,
      nextCreditTrancheAt: nextCreditTrancheAt(margin),
      marginToNextCreditXAF: marginToNextCredit(margin),
      nextTierAt: nextTierThreshold(margin),
      nextNatureAt: nextNatureThreshold(margin),
      trancheXAF: CREDIT_TRANCHE_XAF,
      creditPerTrancheXAF: CREDIT_PER_TRANCHE_XAF,
      tiers: TIER_THRESHOLDS.map((tier) => ({ ...tier })),
      natureThresholds: NATURE_THRESHOLDS.map((tier) => ({ ...tier })),
    };
  }

  /* ══════════════════════════════════════════════════════════════════
   * Helpers
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * Mode financier courant.
   *
   * Le ledger est partitionné par `mode` (`SIMULATION` / `REAL`) et le solde
   * affiché n'est lu que dans le mode du serveur : un crédit doit donc être
   * écrit dans ce même mode. On lit la variable d'environnement plutôt que
   * d'injecter `ConfigService` (le service n'en a pas d'autre usage et cela
   * évite une dépendance de plus dans les tests unitaires).
   */
  private currentMode(): 'SIMULATION' | 'REAL' {
    return process.env.FINANCIAL_MODE === 'REAL' ? 'REAL' : 'SIMULATION';
  }

  private async readProgress(
    userId: string,
  ): Promise<{
    cumulativeMarginXAF: number;
    currentTier: RewardTierName | 'NONE';
    currentTierList: string[];
    currentNatureTier: NatureTierName | 'NONE';
    creditsEarned: number;
    creditsClaimed: number;
    creditsClaimedAt: Date | null;
    natureReached: string[];
    natureClaimed: string[];
    lastMissionAt: Date | null;
    lastCreditClaimAt: Date | null;
  } | null> {
    const row = await this.prisma.clientRewardProgress.findUnique({
      where: { userId },
      select: {
        cumulativeMarginXAF: true,
        currentTier: true,
        currentNatureTier: true,
        creditsEarned: true,
        creditsClaimed: true,
        natureReached: true,
        natureClaimed: true,
        lastMissionAt: true,
        lastCreditClaimAt: true,
      },
    });
    if (!row) return null;
    return {
      cumulativeMarginXAF: row.cumulativeMarginXAF,
      currentTier: row.currentTier,
      /* `currentTier` est l'enum prisma ; on l'expose aussi en liste pour que
       * l'union « paliers atteints » reste lisible des deux côtés. */
      currentTierList: [row.currentTier],
      currentNatureTier: row.currentNatureTier,
      creditsEarned: row.creditsEarned,
      creditsClaimed: row.creditsClaimed,
      creditsClaimedAt: row.lastCreditClaimAt,
      natureReached: row.natureReached,
      natureClaimed: row.natureClaimed,
      lastMissionAt: row.lastMissionAt,
      lastCreditClaimAt: row.lastCreditClaimAt,
    };
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
  | 'NO_ACCEPTED_QUOTE'
  | 'FRAUD_FLAGGED';

export interface RewardCountOutcome {
  counted: boolean;
  reason?: RewardCountReason;
  flagId?: string | null;
  /** Marge cumulée par CETTE mission, XAF entier. */
  marginXAF?: number;
  /** Marge cumulée à vie après ce cumul. */
  cumulativeMarginXAF?: number;
  creditsEarned?: number;
  tiersReached?: RewardTierName[];
  natureReached?: NatureTierName[];
}

export type FraudDecision = 'VALIDATED' | 'REJECTED';

export interface RewardResolution {
  counted: boolean;
  decision: FraudDecision;
  marginXAF?: number;
  cumulativeMarginXAF?: number;
}

export interface CreditsClaimResult {
  /** Montant versé au solde, XAF entier. */
  claimedXAF: number;
  /** Nouveau solde calculé depuis le ledger, XAF entier. */
  newBalanceXAF: number;
  creditsEarned: number;
}

export interface NatureClaimResult {
  success: true;
  tier: string;
  claimedAt: string;
  natureClaimed: string[];
  cumulativeMarginXAF: number;
}

export interface RewardProgressView {
  /** Marge cumulée générée par le client, XAF ENTIER. */
  cumulativeMarginXAF: number;
  currentTier: RewardTierName | 'NONE';
  currentNatureTier: NatureTierName | 'NONE';
  /** Badges atteints (tous, pas seulement le plus haut). */
  reachedTiers: string[];
  creditsEarned: number;
  creditsClaimed: number;
  /** Crédits encore versables. */
  creditsAvailable: number;
  natureReached: NatureTierName[];
  natureClaimed: NatureTierName[];
  lastMissionAt: string | null;
  lastCreditClaimAt: string | null;
  /** Seuil de marge du prochain crédit (touche toujours). */
  nextCreditTrancheAt: number;
  /** Marge restant à générer avant ce prochain crédit. */
  marginToNextCreditXAF: number;
  /** Seuil du prochain badge, `null` si tous atteints. */
  nextTierAt: number | null;
  /** Seuil du prochain palier nature, `null` si tous atteints. */
  nextNatureAt: number | null;
  /** Valeur d'une tranche et d'un crédit, pour l'affichage. */
  trancheXAF: number;
  creditPerTrancheXAF: number;
  tiers: ReadonlyArray<{ tier: RewardTierName; margeXAF: number; label: string; emoji: string }>;
  natureThresholds: ReadonlyArray<{ tier: NatureTierName; margeXAF: number; label: string }>;
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

export { REWARD_TIER_NAMES, NATURE_TIER_NAMES };