import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  FinancialTransactionDirection,
  FinancialTransactionMode,
  FinancialTransactionType,
  SasPayOperationStatus,
} from '../generated/prisma/enums.js';
import {
  CLIENT_PLATFORM_FEE,
  FINANCIAL_CURRENCY,
  FINANCIAL_REFERENCE_ALPHABET,
  FUNDS_HOLD_REFERENCE_LENGTH,
  FUNDS_HOLD_REFERENCE_PREFIX,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_TOPUP_AMOUNT,
  MAX_WITHDRAWAL_AMOUNT,
  MIN_TOPUP_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
  RELIO_COMMISSION_RATE_DENOMINATOR,
  RELIO_COMMISSION_RATE_NUMERATOR,
  RELIO_WITHDRAWAL_NOTE_MAX_LENGTH,
  RELIO_WITHDRAWAL_REFERENCE_ALPHABET,
  RELIO_WITHDRAWAL_REFERENCE_LENGTH,
  RELIO_WITHDRAWAL_REFERENCE_PREFIX,
  STANDARD_TRANSPORT_FEE,
  TECHNICIAN_PLATFORM_FEE,
  TOPUP_INTENT_REFERENCE_LENGTH,
  TOPUP_INTENT_REFERENCE_PREFIX,
  TOTAL_PLATFORM_FEES,
  WITHDRAWAL_REQUEST_REFERENCE_LENGTH,
  WITHDRAWAL_REQUEST_REFERENCE_PREFIX,
  computeRelioCommission,
} from './financial-fees.js';
import {
  SASPAY_TOPUP_COUNTRY,
  SASPAY_TOPUP_NETWORKS,
  isSupportedTopupNetwork,
  normalizeMsisdn,
} from '../saspay/saspay-networks.js';

export type Tx = Prisma.TransactionClient;

export interface LedgerEntryInput {
  userId: string;
  demandeId: string | null;
  type: FinancialTransactionType;
  direction: FinancialTransactionDirection;
  amount: number;
  reference: string;
  reversalOfId?: string | null;
  createdById?: string | null;
  metadata?: Prisma.InputJsonObject | null;
}

export interface QuoteSnapshot {
  id: string;
  amount: number;
  travelAmount: number | null;
  initialTravelFee: number | null;
}

/** Aggrégat financier d'une mission DU POINT DE VUE du client (lecture UI). */
export interface ClientMissionFinance {
  demandeId: string;
  reference: string;
  status: string;
  scheduledAt: string | null;
  repair: number;
  travel: number;
  fee: number;
  totalDebit: number;
  refunded: boolean;
  refundAmount: number;
}

/** Filtres de supervision financière ADMIN (tous optionnels). */
export interface AdminFinanceFilters {
  mode?: FinancialTransactionMode;
  from?: Date;
  to?: Date;
  reference?: string;
}

/**
 * Sprint 8.7-FIN — Moteur financier RepairDom (SIMULATION).
 *
 * Le ledger (FinancialTransaction) est la SEULE source de vérité financière :
 *  - aucun `User.balance` (le solde se calcule : Σ CREDIT − Σ DEBIT des
 *    écritures VALIDATED d'un mode) ;
 *  - aucune API de création/modification/suppression de transaction : les
 *    écritures sont créées UNIQUEMENT par le serveur, atomiquement avec la
 *    transition métier qui les motive ;
 *  - `reference` UNIQUE = idempotence (double clic, retry HTTP, appel répété) ;
 *  - mode SIMULATION/REAL décidé côté serveur via FINANCIAL_MODE (jamais par
 *    le frontend) ;
 *  - corrections futures = contrepassation REVERSAL (reversalOfId), jamais de
 *    modification de l'écriture originale.
 */
@Injectable()
export class FinancialService {
  private readonly logger = new Logger(FinancialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /* ── Configuration mode ─────────────────────────────────────── */

  /** Mode financier courant, décidé côté serveur (FINANCIAL_MODE).
   *  Défaut : SIMULATION. Ce sprint n'autorise que SIMULATION. */
  getMode(): FinancialTransactionMode {
    const raw = this.config.get<string>('FINANCIAL_MODE') ?? 'SIMULATION';
    const value = raw.trim().toUpperCase();
    if (value === 'REAL') return 'REAL';
    if (value !== 'SIMULATION') {
      this.logger.warn(
        `FINANCIAL_MODE inconnu (« ${raw} ») — simulation forcée tant que la valeur n'est pas SIMULATION/REAL.`,
      );
    }
    return 'SIMULATION';
  }

  /** Le mode est autoritaire : une écriture d'un mode ≠ mode serveur est
   *  refusée par construction (le frontend ne choisit jamais le mode). */
  private ensureModeAllowed(mode: FinancialTransactionMode) {
    const server = this.getMode();
    if (mode !== server) {
      throw new ForbiddenException(
        `Le mode financier « ${mode} » n'est pas activé (mode serveur actuel : ${server}).`,
      );
    }
  }

  /* ── Écriture ledger (interne, idempotente) ─────────────────── */

  /** Crée une écriture VALIDATED immuable. Idempotente : si la `reference`
   *  existe déjà, retourne l'écriture existante sans en recréer une seconde.
   *  Doit être appelée DANS la transaction métier de l'événement qui la
   *  motive (acceptation, confirmation, annulation) pour rester atomique. */
  async record(
    tx: Tx,
    input: LedgerEntryInput,
    options: { mode?: FinancialTransactionMode } = {},
  ) {
    const mode = options.mode ?? this.getMode();
    if (input.amount <= 0) {
      throw new BadRequestException(
        'Le montant d’une écriture financière doit être strictement positif (le signe est porté par la direction CREDIT/DEBIT).',
      );
    }

    const existing = await tx.financialTransaction.findUnique({
      where: { reference: input.reference },
    });
    if (existing) return existing;

    try {
      return await tx.financialTransaction.create({
        data: {
          userId: input.userId,
          demandeId: input.demandeId ?? null,
          type: input.type,
          direction: input.direction,
          amount: input.amount,
          status: 'VALIDATED',
          mode,
          reference: input.reference,
          reversalOfId: input.reversalOfId ?? null,
          metadata: input.metadata ?? Prisma.JsonNull,
          createdById: input.createdById ?? null,
        },
      });
    } catch (error) {
      // Course concurrente : l'unicité DB de `reference` fait foi.
      if ((error as { code?: string }).code === 'P2002') {
        const existing = await tx.financialTransaction.findUnique({
          where: { reference: input.reference },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /* ── Règles métier (bonnes fonctions, sous transaction métier) ── */

  /** Découpe un quote en composantes réparation / transport (règle Relio).
   *  Le montant accepté du tarif EST le montant réparation ; le transport est
   *  le standard fixe (2 000 XAF), identique en CATALOG et en MANUAL.
   *  Les snapshots historiques (`travelAmount`, `initialTravelFee`) sont
   *  conservés en base mais ne pilotent plus le calcul : ils restent lisibles
   *  pour l'audit des missions antérieures. */
  splitQuote(input: QuoteSnapshot): { repairAmount: number; travelAmount: number } {
    const repairAmount = input.amount;
    if (repairAmount < 0) {
      throw new BadRequestException('Le montant du tarif ne peut pas être négatif.');
    }
    return { repairAmount, travelAmount: STANDARD_TRANSPORT_FEE };
  }

  /** Montant brut payé par le client : réparation + transport standard. */
  grossForRepair(repairAmount: number): number {
    return repairAmount + STANDARD_TRANSPORT_FEE;
  }

  /** Enregistre le débit client définitif d'une mission (brut = réparation
   *  acceptée + transport 2 000, SANS commission client). Écriture
   *  idempotente par référence serveur (quote + demande + mode).
   *  Depuis SASPAY-02, ce débit n'est plus créé à l'acceptation (qui crée
   *  un FundsHold ACTIVE) mais à la confirmation, via
   *  `settleMissionAtConfirmation()`. Les écritures historiques restent
   *  inchangées et la référence déterministe rend l'appel rejouable. */
  private async recordClientMissionDebit(
    tx: Tx,
    args: {
      demandeId: string;
      clientId: string;
      quote: QuoteSnapshot;
      actorUserId: string;
    },
  ) {
    const mode = this.getMode();
    const { repairAmount, travelAmount } = this.splitQuote(args.quote);
    const grossAmount = repairAmount + travelAmount;

    await this.record(tx, {
      userId: args.clientId,
      demandeId: args.demandeId,
      type: 'CLIENT_MISSION_DEBIT',
      direction: 'DEBIT',
      amount: grossAmount,
      reference: `client-mission-debit:${args.demandeId}:${args.quote.id}:${mode}`,
      createdById: args.actorUserId,
      metadata: {
        repair: repairAmount,
        travel: travelAmount,
        gross: grossAmount,
        currency: FINANCIAL_CURRENCY,
      },
    });
  }

  /** Compatibilité historique — point d'entrée du débit à l'acceptation
   *  (règle pré-SASPAY-02). N'est PLUS appelé par l'acceptation des devis
   *  (voir `holdClientAtAcceptance`) : conservé pour compatibilité et
   *  rejouabilité des missions legacy. Toute nouvelle mission passe par
   *  hold (ACCEPTED) puis `settleMissionAtConfirmation()` (CONFIRMED). */
  async debitClientAtAcceptance(
    tx: Tx,
    args: {
      demandeId: string;
      clientId: string;
      quote: QuoteSnapshot;
      actorUserId: string;
    },
  ) {
    await this.recordClientMissionDebit(tx, args);
  }

  /** Acceptation d'un quote — réservation client (SASPAY-02, ATOMIQUE avec
   *  l'acceptation quand appelé dans la même transaction que le claim) :
   *    FundsHold ACTIVE = brut (réparation acceptée + transport 2 000)
   *  AUCUNE écriture ledger : le disponible diminue (ledger − holds ACTIVE)
   *  sans débit définitif. Le débit CLIENT_MISSION_DEBIT n'est créé qu'à la
   *  confirmation (`settleMissionAtConfirmation`) ; l'annulation libère le
   *  hold (`releaseMissionHoldIfAny`) sans contrepassation.
   *  Référence déterministe `mission-hold:{demandeId}:{mode}` : un retry ne
   *  crée jamais un deuxième hold. 400 INSUFFICIENT_FUNDS (avec required /
   *  available exploitables) si le disponible sous verrou est insuffisant —
   *  dans ce cas l'appelant doit annuler sa transaction (mission non
   *  acceptée, aucun hold, aucun mouvement ledger). */
  async holdClientAtAcceptance(
    tx: Tx,
    args: {
      demandeId: string;
      clientId: string;
      quote: QuoteSnapshot;
      actorUserId: string;
    },
  ) {
    const mode = this.getMode();
    const { repairAmount, travelAmount } = this.splitQuote(args.quote);
    const grossAmount = repairAmount + travelAmount;
    const reference = `mission-hold:${args.demandeId}:${mode}`;

    await this.lockUserFunds(tx, args.clientId);

    const existing = await tx.fundsHold.findUnique({ where: { reference } });
    if (existing) return existing;

    const available = await this.getAvailableBalance(args.clientId, mode, tx);
    if (grossAmount > available) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_FUNDS',
        message: `Fonds insuffisants : ${grossAmount} XAF requis pour ${available} XAF disponibles. Rechargez votre compte pour accepter ce tarif.`,
        required: grossAmount,
        available,
        currency: FINANCIAL_CURRENCY,
      });
    }

    try {
      return await tx.fundsHold.create({
        data: {
          reference,
          userId: args.clientId,
          demandeId: args.demandeId,
          amount: grossAmount,
          currency: FINANCIAL_CURRENCY,
          mode,
          status: 'ACTIVE',
          metadata: {
            repair: repairAmount,
            travel: travelAmount,
            gross: grossAmount,
            quoteId: args.quote.id,
            currency: FINANCIAL_CURRENCY,
          },
          createdById: args.actorUserId,
        },
      });
    } catch (error) {
      // Course concurrente : l'unicité DB de `reference` fait foi.
      if ((error as { code?: string }).code === 'P2002') {
        const concurrent = await tx.fundsHold.findUnique({ where: { reference } });
        if (concurrent) return concurrent;
      }
      throw error;
    }
  }

  /** Règlement d'une mission à la confirmation (SASPAY-02, ATOMIQUE avec
   *  la transition CONFIRMED quand appelé dans la même transaction) :
   *    1. hold mission ACTIVE → CONSUMED (si présent ; absent = mission
   *       legacy sans hold, on continue sans convertir d'historique) ;
   *    2. débit client définitif CLIENT_MISSION_DEBIT (référence
   *       déterministe → rejouable, no-op si déjà débité en legacy) ;
   *    3. règlement technicien (`settleTechnicianAtConfirmation`, lui-même
   *       idempotent).
   *  Jamais de hold CONSUMED sans débit+crédits (même transaction), jamais
   *  de double règlement (références idempotentes), jamais de hold rétroactif
   *  pour les anciennes missions. Sans quote ACCEPTED : aucune écriture. */
  async settleMissionAtConfirmation(
    tx: Tx,
    args: { demandeId: string; clientId: string; technicianId: string | null; createdById: string },
  ) {
    const mode = this.getMode();

    const quote = await tx.quote.findFirst({
      where: { demandeId: args.demandeId, status: 'ACCEPTED' },
      select: { id: true, amount: true, travelAmount: true, initialTravelFee: true },
    });
    if (!quote) {
      // Mission legacy sans tarif accepté : aucune écriture, comme avant.
      await this.settleTechnicianAtConfirmation(tx, {
        demandeId: args.demandeId,
        technicianId: args.technicianId,
        createdById: args.createdById,
      });
      return;
    }

    await this.lockUserFunds(tx, args.clientId);

    // Consommation gardée : seul un hold encore ACTIVE bascule. Déjà
    // CONSUMED (retry) = on continue idempotemment ; aucun autre statut
    // n'est régressé.
    const holdReference = `mission-hold:${args.demandeId}:${mode}`;
    const hold = await tx.fundsHold.findUnique({ where: { reference: holdReference } });
    if (hold && hold.status === 'ACTIVE') {
      const consumed = await tx.fundsHold.updateMany({
        where: { reference: holdReference, status: 'ACTIVE' },
        data: { status: 'CONSUMED', releasedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new ConflictException(
          'La réservation de cette mission a été modifiée entre-temps. Veuillez réessayer.',
        );
      }
    }

    await this.recordClientMissionDebit(tx, {
      demandeId: args.demandeId,
      clientId: args.clientId,
      quote,
      actorUserId: args.createdById,
    });

    await this.settleTechnicianAtConfirmation(tx, {
      demandeId: args.demandeId,
      technicianId: args.technicianId,
      createdById: args.createdById,
    });
  }

  /** Libération du hold mission à l'annulation (SASPAY-02) :
   *    FundsHold ACTIVE → RELEASED (fonds à nouveau disponibles).
   *  AUCUNE écriture ledger : ni CLIENT_TOPUP, ni payout, ni faux dépôt —
   *  la restitution est purement interne (le hold n'est plus déduit du
   *  disponible). Idempotent : sans hold ou hold déjà traité = no-op
   *  (les missions legacy avec CLIENT_MISSION_DEBIT restent couvertes par
   *  `reverseClientDebitIfAny`, appelé en plus par la transition CANCELED). */
  async releaseMissionHoldIfAny(tx: Tx, args: { demandeId: string }) {
    const mode = this.getMode();
    const holdReference = `mission-hold:${args.demandeId}:${mode}`;
    const hold = await tx.fundsHold.findUnique({ where: { reference: holdReference } });
    if (!hold || hold.status !== 'ACTIVE') return hold ?? null;
    await this.lockUserFunds(tx, hold.userId);
    await tx.fundsHold.updateMany({
      where: { reference: holdReference, status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    return tx.fundsHold.findUnique({ where: { reference: holdReference } });
  }

  /** Confirmation de la mission — rémunération du technicien (atomique avec
   *  la transition CONFIRMED, dans la même transaction) :
   *    TECHNICIAN_REPAIR_REVENUE CREDIT = réparation (montant accepté)
   *    TECHNICIAN_TRAVEL_REVENUE CREDIT = transport standard (2 000 XAF)
   *    TECHNICIAN_FEE            DEBIT  = commission Relio 2 % du brut
   *  Net technicien = brut − commission. Rien n'est crédité à COMPLETED :
   *  la commission n'est due qu'à la validation finale (CONFIRMED), jamais à
   *  la création, au dispatch, à l'acceptation technicien, au devis, à
   *  l'acceptation du devis ni pendant la négociation.
   *  Missions legacy sans quote ACCEPTED : aucune écriture (pas de transaction
   *  rétroactive). Écritures idempotentes par `reference` (double validation =
   *  aucun doublon).
   *  Depuis SASPAY-02, appelé par `settleMissionAtConfirmation()` qui consomme
   *  au préalable le hold mission et enregistre le débit client définitif. */
  async settleTechnicianAtConfirmation(
    tx: Tx,
    args: { demandeId: string; technicianId: string | null; createdById: string },
  ) {
    if (!args.technicianId) return;
    const mode = this.getMode();

    const quote = await tx.quote.findFirst({
      where: { demandeId: args.demandeId, status: 'ACCEPTED' },
      select: { id: true, amount: true, travelAmount: true, initialTravelFee: true },
    });
    if (!quote) return;

    const { repairAmount, travelAmount } = this.splitQuote(quote);
    const grossAmount = repairAmount + travelAmount;
    const commission = computeRelioCommission(grossAmount);

    // Une composante réparation nulle ne donne pas lieu à une écriture ; le
    // transport standard (2 000) est toujours crédité au technicien.
    if (repairAmount > 0) {
      await this.record(tx, {
        userId: args.technicianId,
        demandeId: args.demandeId,
        type: 'TECHNICIAN_REPAIR_REVENUE',
        direction: 'CREDIT',
        amount: repairAmount,
        reference: `technician-repair:${args.demandeId}:${quote.id}:${mode}`,
        createdById: args.createdById,
        metadata: {
          repair: repairAmount,
          travel: travelAmount,
          gross: grossAmount,
          currency: FINANCIAL_CURRENCY,
        },
      });
    }

    if (travelAmount > 0) {
      await this.record(tx, {
        userId: args.technicianId,
        demandeId: args.demandeId,
        type: 'TECHNICIAN_TRAVEL_REVENUE',
        direction: 'CREDIT',
        amount: travelAmount,
        reference: `technician-travel:${args.demandeId}:${quote.id}:${mode}`,
        createdById: args.createdById,
        metadata: {
          repair: repairAmount,
          travel: travelAmount,
          gross: grossAmount,
          currency: FINANCIAL_CURRENCY,
        },
      });
    }

    await this.record(tx, {
      userId: args.technicianId,
      demandeId: args.demandeId,
      type: 'TECHNICIAN_FEE',
      direction: 'DEBIT',
      amount: commission,
      reference: `technician-fee:${args.demandeId}:${quote.id}:${mode}`,
      createdById: args.createdById,
      metadata: {
        fee: commission,
        gross: grossAmount,
        rateNumerator: RELIO_COMMISSION_RATE_NUMERATOR,
        rateDenominator: RELIO_COMMISSION_RATE_DENOMINATOR,
        currency: FINANCIAL_CURRENCY,
      },
    });
  }

  /** Annulation d'une mission déjà débitée — contrepassation atomique (même
   *  transaction que le passage à CANCELED) :
   *    REVERSAL CREDIT = montant débité (réparation + transport 2 000)
   *    REVERSAL CREDIT = frais client legacy (100 XAF) s'ils existent
   *  Les écritures originales ne sont JAMAIS modifiées ni supprimées ;
   *  chaque contrepassation est liée par reversalOfId et idempotente.
   *  Depuis SASPAY-02, les nouvelles missions sont couvertes par hold
   *  (libéré via `releaseMissionHoldIfAny`, sans écriture) : sans
   *  CLIENT_MISSION_DEBIT existant, cette méthode est un no-op. Conservée
   *  pour les missions historiques débitées à l'acceptation. */
  async reverseClientDebitIfAny(tx: Tx, args: { demandeId: string; clientId: string }) {
    const mode = this.getMode();

    const debit = await tx.financialTransaction.findFirst({
      where: {
        demandeId: args.demandeId,
        userId: args.clientId,
        type: 'CLIENT_MISSION_DEBIT',
        mode,
        status: 'VALIDATED',
      },
    });
    if (!debit) return;

    const fee = await tx.financialTransaction.findFirst({
      where: {
        demandeId: args.demandeId,
        userId: args.clientId,
        type: 'CLIENT_FEE',
        mode,
        status: 'VALIDATED',
      },
    });

    const accepted = await tx.quote.findFirst({
      where: { demandeId: args.demandeId, status: 'ACCEPTED' },
      select: { id: true },
    });
    const refBase = accepted?.id ?? debit.id;

    await this.record(tx, {
      userId: args.clientId,
      demandeId: args.demandeId,
      type: 'REVERSAL',
      direction: 'CREDIT',
      amount: debit.amount,
      reference: `client-refund:${args.demandeId}:${refBase}:${mode}`,
      reversalOfId: debit.id,
      createdById: args.clientId,
      metadata: {
        reversedType: debit.type,
        originalReference: debit.reference,
        currency: FINANCIAL_CURRENCY,
      },
    });

    if (fee) {
      await this.record(tx, {
        userId: args.clientId,
        demandeId: args.demandeId,
        type: 'REVERSAL',
        direction: 'CREDIT',
        amount: fee.amount,
        reference: `client-fee-refund:${args.demandeId}:${refBase}:${mode}`,
        reversalOfId: fee.id,
        createdById: args.clientId,
        metadata: {
          reversedType: fee.type,
          originalReference: fee.reference,
          currency: FINANCIAL_CURRENCY,
        },
      });
    }
  }

  /* ── Lecteurs ledger (jamais de userId fourni par le frontend) ── */

  /** Solde d'un utilisateur : Σ CREDIT − Σ DEBIT (VALIDATED), par mode.
   *  Le userId doit provenir du contexte serveur (JWT pour les routes). */
  async getBalance(userId: string, mode: FinancialTransactionMode): Promise<number> {
    this.ensureModeAllowed(mode);
    const [credits, debits] = await Promise.all([
      this.prisma.financialTransaction.aggregate({
        where: { userId, mode, status: 'VALIDATED', direction: 'CREDIT' },
        _sum: { amount: true },
      }),
      this.prisma.financialTransaction.aggregate({
        where: { userId, mode, status: 'VALIDATED', direction: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);
    return (credits._sum.amount ?? 0) - (debits._sum.amount ?? 0);
  }

  /** Solde client (alias lisible). */
  getClientBalance(userId: string, mode: FinancialTransactionMode): Promise<number> {
    return this.getBalance(userId, mode);
  }

  /* ── Lecteurs UI (routes READ-ONLY, userId TOUJOURS issu du JWT) ── */

  /** Synthèse client « Mon solde » (Sprint 8.7-FIN-UI).
   *  Le solde, les totaux et l'historique sont calculés côté backend ;
   *  le frontend ne recalcule JAMAIS le solde depuis des données partielles. */
  async getClientFinanceSummary(userId: string) {
    const mode = this.getMode();
    const balance = await this.getClientBalance(userId, mode);

    const rows = await this.prisma.financialTransaction.findMany({
      where: { userId, mode },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        demande: {
          select: {
            id: true,
            reference: true,
            status: true,
            scheduledAt: true,
          },
        },
      },
    });

    let totalCredit = 0;
    let totalDebit = 0;
    const missions = new Map<string, ClientMissionFinance>();
    const transactions = rows.map((t) => {
      if (t.status === 'VALIDATED') {
        if (t.direction === 'CREDIT') totalCredit += t.amount;
        else totalDebit += t.amount;
      }

      // Regroupement par mission (si liée) : réparation / transport / frais /
      // total débité / remboursement. Les composantes sont lues depuis les
      // métadonnées serveur écrites au débit — jamais recalculées côté UI.
      if (t.demandeId && t.demande) {
        const mission = missions.get(t.demandeId) ?? {
          demandeId: t.demandeId,
          reference: t.demande.reference,
          status: t.demande.status,
          scheduledAt: t.demande.scheduledAt
            ? t.demande.scheduledAt.toISOString()
            : null,
          repair: 0,
          travel: 0,
          fee: 0,
          totalDebit: 0,
          refunded: false,
          refundAmount: 0,
        };
        const meta = (t.metadata ?? {}) as {
          repair?: number;
          travel?: number;
          fee?: number;
        };
        if (t.type === 'CLIENT_MISSION_DEBIT' && t.direction === 'DEBIT') {
          mission.repair += meta.repair ?? t.amount;
          mission.travel += meta.travel ?? 0;
          mission.totalDebit += t.amount;
        }
        if (t.type === 'CLIENT_FEE' && t.direction === 'DEBIT') {
          mission.fee += t.amount;
        }
        if (t.type === 'REVERSAL' && t.direction === 'CREDIT') {
          mission.refunded = true;
          mission.refundAmount += t.amount;
        }
        missions.set(t.demandeId, mission);
      }

      return {
        id: t.id,
        type: t.type,
        direction: t.direction,
        amount: t.amount,
        status: t.status,
        mode: t.mode,
        reference: t.reference,
        reversalOfId: t.reversalOfId,
        createdAt: t.createdAt.toISOString(),
        metadata: (t.metadata ?? null) as Record<string, unknown> | null,
        demande: t.demande
          ? {
              id: t.demande.id,
              reference: t.demande.reference,
              status: t.demande.status,
              scheduledAt: t.demande.scheduledAt
                ? t.demande.scheduledAt.toISOString()
                : null,
            }
          : null,
      };
    });

    return {
      mode,
      currency: FINANCIAL_CURRENCY,
      balance,
      totals: { credit: totalCredit, debit: totalDebit, net: totalCredit - totalDebit },
      missions: [...missions.values()].sort((a, b) =>
        (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? ''),
      ),
      transactions,
    };
  }

  /** Transactions technicien réglées (répertoire partagé UI/admin). */
  private async loadTechnicianTransactions(userId: string, mode: FinancialTransactionMode) {
    return this.prisma.financialTransaction.findMany({
      where: { userId, mode, status: 'VALIDATED' },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        demande: {
          select: {
            id: true,
            reference: true,
            status: true,
            scheduledAt: true,
            client: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });
  }

  /** Finances technicien : réparation, transport, frais, brut, net,
   *  disponible et historique des écritures liées aux missions. */
  async getTechnicianFinances(userId: string, mode: FinancialTransactionMode) {
    this.ensureModeAllowed(mode);
    const rows = await this.prisma.financialTransaction.findMany({
      where: { userId, mode, status: 'VALIDATED' },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        demande: {
          select: {
            id: true,
            reference: true,
            status: true,
            scheduledAt: true,
            client: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    let repair = 0;
    let travel = 0;
    let platformFee = 0;
    let net = 0;
    const history = rows.map((t) => {
      const signed = t.direction === 'CREDIT' ? t.amount : -t.amount;
      net += signed;
      if (t.type === 'TECHNICIAN_REPAIR_REVENUE') repair += t.amount;
      if (t.type === 'TECHNICIAN_TRAVEL_REVENUE') travel += t.amount;
      if (t.type === 'TECHNICIAN_FEE') platformFee += t.amount;
      return {
        id: t.id,
        type: t.type,
        direction: t.direction,
        amount: t.amount,
        reference: t.reference,
        reversalOfId: t.reversalOfId,
        createdAt: t.createdAt.toISOString(),
        demande: t.demande
          ? {
              id: t.demande.id,
              reference: t.demande.reference,
              status: t.demande.status,
              scheduledAt: t.demande.scheduledAt ? t.demande.scheduledAt.toISOString() : null,
              client: t.demande.client,
            }
          : null,
      };
    });

    const gross = repair + travel;
    return {
      gross,
      repair,
      travel,
      platformFee,
      net,
      available: net,
      history,
    };
  }

  /** Synthèse technicien « Mes revenus » (Sprint 8.7-FIN-UI).
   *  Gross/nett/available et le découpage par mission sont calculés côté
   *  backend. Le transport est toujours une composante du revenu technicien,
   *  jamais un frais RepairDom. */
  async getTechnicianFinanceSummary(userId: string) {
    const mode = this.getMode();
    const rows = await this.loadTechnicianTransactions(userId, mode);

    let repairRevenue = 0;
    let travelRevenue = 0;
    let platformFees = 0;
    let netRevenue = 0;
    const missionsById = new Map<
      string,
      {
        demandeId: string;
        reference: string;
        status: string;
        scheduledAt: string | null;
        settledAt: Date | null;
        repair: number;
        travel: number;
        fees: number;
        gross: number;
        net: number;
      }
    >();

    const transactions = rows.map((t) => {
      const signed = t.direction === 'CREDIT' ? t.amount : -t.amount;
      netRevenue += signed;
      if (t.type === 'TECHNICIAN_REPAIR_REVENUE') repairRevenue += t.amount;
      if (t.type === 'TECHNICIAN_TRAVEL_REVENUE') travelRevenue += t.amount;
      if (t.type === 'TECHNICIAN_FEE') platformFees += t.amount;

      if (t.demandeId && t.demande) {
        const mission = missionsById.get(t.demandeId) ?? {
          demandeId: t.demandeId,
          reference: t.demande.reference,
          status: t.demande.status,
          scheduledAt: t.demande.scheduledAt
            ? t.demande.scheduledAt.toISOString()
            : null,
          settledAt: null,
          repair: 0,
          travel: 0,
          fees: 0,
          gross: 0,
          net: 0,
        };
        if (t.type === 'TECHNICIAN_REPAIR_REVENUE') mission.repair += t.amount;
        if (t.type === 'TECHNICIAN_TRAVEL_REVENUE') mission.travel += t.amount;
        if (t.type === 'TECHNICIAN_FEE') mission.fees += t.amount;
        if (!mission.settledAt || t.createdAt > mission.settledAt) {
          mission.settledAt = t.createdAt;
        }
        missionsById.set(t.demandeId, mission);
      }

      return {
        id: t.id,
        type: t.type,
        direction: t.direction,
        amount: t.amount,
        status: t.status,
        mode: t.mode,
        reference: t.reference,
        reversalOfId: t.reversalOfId,
        createdAt: t.createdAt.toISOString(),
        demande: t.demande
          ? {
              id: t.demande.id,
              reference: t.demande.reference,
              status: t.demande.status,
              scheduledAt: t.demande.scheduledAt
                ? t.demande.scheduledAt.toISOString()
                : null,
              client: t.demande.client,
            }
          : null,
      };
    });

    const missions = [...missionsById.values()]
      .map((m) => ({
        ...m,
        gross: m.repair + m.travel,
        net: m.repair + m.travel - m.fees,
        settledAt: m.settledAt ? m.settledAt.toISOString() : null,
      }))
      .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));

    const grossRevenue = repairRevenue + travelRevenue;
    return {
      mode,
      currency: FINANCIAL_CURRENCY,
      grossRevenue,
      repairRevenue,
      travelRevenue,
      platformFees,
      netRevenue,
      available: netRevenue,
      missions,
      transactions,
    };
  }

  /** Réconciliation Relio par mission financièrement réglée.
   *  Nouvelle règle : revenu Relio = commission 2 % du brut technicien
   *  (aucune commission client). Missions antérieures : les écritures
   *  CLIENT_FEE legacy (100 XAF) restent comptées telles quelles et la mission
   *  est réconciliée contre l'ancien attendu (100 + 150 = 250) — sans jamais
   *  réécrire l'historique. Le transport et la réparation ne sont jamais
   *  comptés comme revenu Relio ; Pricing.serviceFee non plus. */
  async getMissionFinancialSummary(demandeId: string, mode: FinancialTransactionMode) {
    this.ensureModeAllowed(mode);
    const rows = await this.prisma.financialTransaction.findMany({
      where: { demandeId, mode },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });

    const entries = rows.map((t) => ({
      id: t.id,
      userId: t.userId,
      user: t.user,
      demandeId: t.demandeId,
      type: t.type,
      direction: t.direction,
      amount: t.amount,
      status: t.status,
      mode: t.mode,
      reference: t.reference,
      reversalOfId: t.reversalOfId,
      createdAt: t.createdAt.toISOString(),
    }));

    const sum = (type: FinancialTransactionType, direction: FinancialTransactionDirection) =>
      rows
        .filter(
          (t) => t.type === type && t.direction === direction && t.status === 'VALIDATED',
        )
        .reduce((acc, t) => acc + t.amount, 0);

    const clientFee = sum('CLIENT_FEE', 'DEBIT');
    const technicianFee = sum('TECHNICIAN_FEE', 'DEBIT');
    const clientMissionDebit = sum('CLIENT_MISSION_DEBIT', 'DEBIT');
    const repairDomRevenue = clientFee + technicianFee;
    const isLegacyMission = clientFee > 0;
    const expectedRepairDomRevenue = isLegacyMission
      ? TOTAL_PLATFORM_FEES
      : clientMissionDebit > 0
        ? computeRelioCommission(clientMissionDebit)
        : 0;
    const reconciled = isLegacyMission
      ? repairDomRevenue === TOTAL_PLATFORM_FEES
      : clientMissionDebit > 0 &&
        clientFee === 0 &&
        technicianFee === expectedRepairDomRevenue &&
        technicianFee > 0;

    return {
      demandeId,
      financials: {
        clientMissionDebit,
        clientFee,
        technicianRepair: sum('TECHNICIAN_REPAIR_REVENUE', 'CREDIT'),
        technicianTravel: sum('TECHNICIAN_TRAVEL_REVENUE', 'CREDIT'),
        technicianFee,
        repairDomRevenue,
        expectedRepairDomRevenue,
        reconciled,
      },
      entries,
    };
  }

  /** Vérifie la réconciliation globale des commissions Relio sur toutes les
   *  missions du mode : aucune mission ne doit présenter d'écart.
   *  Missions antérieures (avec CLIENT_FEE legacy) : attendu 100 + 150 = 250.
   *  Nouvelles missions : attendu = 2 % du brut débité au client, sans
   *  commission client. */
  async reconcileRepairDomFees(mode: FinancialTransactionMode) {
    this.ensureModeAllowed(mode);
    const rows = await this.prisma.financialTransaction.findMany({
      where: {
        mode,
        type: { in: ['CLIENT_MISSION_DEBIT', 'CLIENT_FEE', 'TECHNICIAN_FEE'] },
      },
      select: { demandeId: true, type: true, direction: true, amount: true, status: true },
    });

    const byMission = new Map<
      string,
      { clientDebit: number; clientFee: number; technicianFee: number }
    >();
    for (const t of rows) {
      if (!t.demandeId || t.status !== 'VALIDATED') continue;
      const bucket = byMission.get(t.demandeId) ?? { clientDebit: 0, clientFee: 0, technicianFee: 0 };
      if (t.type === 'CLIENT_MISSION_DEBIT' && t.direction === 'DEBIT')
        bucket.clientDebit += t.amount;
      if (t.type === 'CLIENT_FEE' && t.direction === 'DEBIT') bucket.clientFee += t.amount;
      if (t.type === 'TECHNICIAN_FEE' && t.direction === 'DEBIT') bucket.technicianFee += t.amount;
      byMission.set(t.demandeId, bucket);
    }

    const missions = [...byMission.entries()]
      .filter(([, fees]) => fees.clientFee > 0 || fees.technicianFee > 0)
      .map(([demandeId, fees]) => {
        const isLegacy = fees.clientFee > 0;
        const expected = isLegacy
          ? TOTAL_PLATFORM_FEES
          : fees.clientDebit > 0
            ? computeRelioCommission(fees.clientDebit)
            : 0;
        const total = fees.clientFee + fees.technicianFee;
        const reconciled = isLegacy
          ? total === TOTAL_PLATFORM_FEES
          : fees.clientDebit > 0 &&
            fees.clientFee === 0 &&
            fees.technicianFee === expected &&
            expected > 0;
        return { demandeId, ...fees, total, expected, legacy: isLegacy, reconciled };
      });

    const mismatched = missions.filter((m) => !m.reconciled);
    return {
      totalMissions: missions.length,
      mismatches: mismatched,
      expectedPerMission: {
        transport: STANDARD_TRANSPORT_FEE,
        commissionRateNumerator: RELIO_COMMISSION_RATE_NUMERATOR,
        commissionRateDenominator: RELIO_COMMISSION_RATE_DENOMINATOR,
        legacyTotal: TOTAL_PLATFORM_FEES,
      },
    };
  }

  /* ── Supervision ADMIN (Sprint 8.7-FIN-UI) ───────────────────── */

  /** Synthèse globale « Finances RepairDom » par mode (SIMULATION / REAL).
   *  Les filtres (mode, période, référence mission) sont appliqués CÔTÉ
   *  BACKEND ; le frontend affiche un résultat déjà agrégé et n'invente
   *  jamais les totaux ni l'état de réconciliation. */
  async getAdminFinanceSummary(filters: AdminFinanceFilters = {}) {
    const modes: FinancialTransactionMode[] = ['SIMULATION', 'REAL'];
    const results: Record<string, unknown> = {};
    for (const mode of modes) {
      results[mode] = await this.computeAdminModeFinance(mode, filters);
    }
    return {
      currency: FINANCIAL_CURRENCY,
      expectedPerMission: {
        transport: STANDARD_TRANSPORT_FEE,
        commissionRateNumerator: RELIO_COMMISSION_RATE_NUMERATOR,
        commissionRateDenominator: RELIO_COMMISSION_RATE_DENOMINATOR,
        // Historique uniquement : ancien forfait 100 (client) + 150 (techno).
        clientFee: CLIENT_PLATFORM_FEE,
        technicianFee: TECHNICIAN_PLATFORM_FEE,
        total: TOTAL_PLATFORM_FEES,
      },
      results,
    };
  }

  private async computeAdminModeFinance(
    mode: FinancialTransactionMode,
    filters: AdminFinanceFilters,
  ) {
    const where: Prisma.FinancialTransactionWhereInput = { mode };
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    if (filters.reference) {
      where.demande = {
        reference: { contains: filters.reference.trim(), mode: 'insensitive' },
      };
    }

    const rows = await this.prisma.financialTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000,
      include: {
        demande: {
          select: {
            id: true,
            reference: true,
            status: true,
            createdAt: true,
            client: { select: { id: true, firstName: true, lastName: true } },
            technician: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    let repair = 0;
    let travel = 0;
    let clientFees = 0;
    let technicianFees = 0;
    let clientDebits = 0;
    let technicianGross = 0;
    const missionsById = new Map<
      string,
      {
        demandeId: string;
        reference: string | null;
        status: string | null;
        date: string | null;
        client: { id: string; firstName: string; lastName: string | null } | null;
        technician: { id: string; firstName: string; lastName: string | null } | null;
        repair: number;
        travel: number;
        clientDebit: number;
        clientFee: number;
        technicianFee: number;
        technicianNet: number;
        repairDomRevenue: number;
        reconciled: boolean;
        lastActivity: string;
      }
    >();
    let hasAnyFinancialTransaction = false;

    for (const t of rows) {
      hasAnyFinancialTransaction = true;
      if (t.status !== 'VALIDATED') continue;
      if (t.type === 'TECHNICIAN_REPAIR_REVENUE' && t.direction === 'CREDIT') {
        repair += t.amount;
        technicianGross += t.amount;
      }
      if (t.type === 'TECHNICIAN_TRAVEL_REVENUE' && t.direction === 'CREDIT') {
        travel += t.amount;
        technicianGross += t.amount;
      }
      if (t.type === 'CLIENT_FEE' && t.direction === 'DEBIT') clientFees += t.amount;
      if (t.type === 'TECHNICIAN_FEE' && t.direction === 'DEBIT') technicianFees += t.amount;
      if (t.type === 'CLIENT_MISSION_DEBIT' && t.direction === 'DEBIT') clientDebits += t.amount;

      if (t.demandeId) {
        const mission = missionsById.get(t.demandeId) ?? {
          demandeId: t.demandeId,
          reference: t.demande?.reference ?? null,
          status: t.demande?.status ?? null,
          date: t.demande?.createdAt ? t.demande.createdAt.toISOString() : null,
          client: t.demande?.client ?? null,
          technician: t.demande?.technician ?? null,
          repair: 0,
          travel: 0,
          clientDebit: 0,
          clientFee: 0,
          technicianFee: 0,
          technicianNet: 0,
          repairDomRevenue: 0,
          reconciled: true,
          lastActivity: t.createdAt.toISOString(),
        };
        if (t.type === 'TECHNICIAN_REPAIR_REVENUE') mission.repair += t.amount;
        if (t.type === 'TECHNICIAN_TRAVEL_REVENUE') mission.travel += t.amount;
        if (t.type === 'CLIENT_MISSION_DEBIT' && t.direction === 'DEBIT')
          mission.clientDebit += t.amount;
        if (t.type === 'CLIENT_FEE') mission.clientFee += t.amount;
        if (t.type === 'TECHNICIAN_FEE') mission.technicianFee += t.amount;
        mission.technicianNet = mission.repair + mission.travel - mission.technicianFee;
        mission.repairDomRevenue = mission.clientFee + mission.technicianFee;
        // Missions antérieures (frais client legacy) : attendu 250.
        // Nouvelles missions : commission 2 % du brut débité, sans frais client.
        if (mission.clientFee > 0) {
          mission.reconciled =
            mission.repairDomRevenue === TOTAL_PLATFORM_FEES &&
            mission.technicianFee > 0;
        } else {
          const expected =
            mission.clientDebit > 0 ? computeRelioCommission(mission.clientDebit) : 0;
          mission.reconciled =
            mission.clientDebit > 0 &&
            mission.technicianFee === expected &&
            expected > 0;
        }
        if (t.createdAt.toISOString() > mission.lastActivity) {
          mission.lastActivity = t.createdAt.toISOString();
        }
        missionsById.set(t.demandeId, mission);
      }
    }

    const missions = [...missionsById.values()].sort((a, b) =>
      b.lastActivity.localeCompare(a.lastActivity),
    );
    const reconciledMissions = missions.filter((m) => m.reconciled).length;
    const mismatchMissions = missions.length - reconciledMissions;

    return {
      mode,
      totals: {
        missionsCount: missions.length,
        transactionsCount: rows.length,
        hasAnyFinancialTransaction,
        repair,
        travel,
        clientFees,
        technicianFees,
        repairDomRevenue: clientFees + technicianFees,
        technicianGross,
        technicianNet: technicianGross - technicianFees,
        clientDebits,
      },
      missions,
      reconciliation: {
        missionsCount: missions.length,
        reconciledMissions,
        mismatchMissions,
        ok: missions.length === 0 ? null : mismatchMissions === 0,
        expectedPerMission: {
          transport: STANDARD_TRANSPORT_FEE,
          commissionRateNumerator: RELIO_COMMISSION_RATE_NUMERATOR,
          commissionRateDenominator: RELIO_COMMISSION_RATE_DENOMINATOR,
          legacyTotal: TOTAL_PLATFORM_FEES,
        },
      },
    };
  }

  /** Détail financier d'une mission pour l'ADMIN (supervision) : mission +
   *  quote accepté (snapshot) + transactions ledger immuables. Les données
   *  sensibles non financières (KYC, storagePath, JWT…) ne sont pas exposées. */
  async getAdminMissionFinance(demandeId: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: {
        id: true,
        reference: true,
        status: true,
        createdAt: true,
        finalAmount: true,
        client: { select: { id: true, firstName: true, lastName: true } },
        technician: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');

    const quote = await this.prisma.quote.findFirst({
      where: { demandeId, status: 'ACCEPTED' },
      select: {
        id: true,
        amount: true,
        currency: true,
        travelAmount: true,
        initialTravelFee: true,
        createdAt: true,
      },
    });

    const rows = await this.prisma.financialTransaction.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, role: true } },
      },
    });

    const sum = (type: FinancialTransactionType, direction: FinancialTransactionDirection) =>
      rows
        .filter((t) => t.type === type && t.direction === direction && t.status === 'VALIDATED')
        .reduce((acc, t) => acc + t.amount, 0);

    const technicianRepair = sum('TECHNICIAN_REPAIR_REVENUE', 'CREDIT');
    const technicianTravel = sum('TECHNICIAN_TRAVEL_REVENUE', 'CREDIT');
    const technicianFee = sum('TECHNICIAN_FEE', 'DEBIT');
    const clientFee = sum('CLIENT_FEE', 'DEBIT');
    const clientMissionDebit = sum('CLIENT_MISSION_DEBIT', 'DEBIT');
    const reversalCredit = rows
      .filter((t) => t.type === 'REVERSAL' && t.direction === 'CREDIT' && t.status === 'VALIDATED')
      .reduce((acc, t) => acc + t.amount, 0);
    const repairDomRevenue = clientFee + technicianFee;
    const isLegacyMission = clientFee > 0;
    const expectedRepairDomRevenue = isLegacyMission
      ? TOTAL_PLATFORM_FEES
      : clientMissionDebit > 0
        ? computeRelioCommission(clientMissionDebit)
        : 0;
    const reconciled = isLegacyMission
      ? repairDomRevenue === TOTAL_PLATFORM_FEES
      : clientMissionDebit > 0 &&
        clientFee === 0 &&
        technicianFee === expectedRepairDomRevenue &&
        technicianFee > 0;

    return {
      demande: {
        id: demande.id,
        reference: demande.reference,
        status: demande.status,
        createdAt: demande.createdAt.toISOString(),
        finalAmount: demande.finalAmount,
        client: demande.client,
        technician: demande.technician,
      },
      quote: quote
        ? (() => {
            const split = this.splitQuote(quote);
            return {
              id: quote.id,
              amount: quote.amount,
              currency: quote.currency,
              createdAt: quote.createdAt.toISOString(),
              repair: split.repairAmount,
              travel: split.travelAmount,
            };
          })()
        : null,
      financials: {
        clientMissionDebit,
        clientFee,
        technicianRepair,
        technicianTravel,
        technicianFee,
        netTechnician: technicianRepair + technicianTravel - technicianFee,
        repairDomRevenue,
        expectedRepairDomRevenue,
        reconciled,
        clientRefunded: reversalCredit > 0,
        clientRefundAmount: reversalCredit,
      },
      transactions: rows.map((t) => ({
        id: t.id,
        userId: t.userId,
        user: t.user,
        demandeId: t.demandeId,
        type: t.type,
        direction: t.direction,
        amount: t.amount,
        status: t.status,
        mode: t.mode,
        reference: t.reference,
        reversalOfId: t.reversalOfId,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  /* ── Provisionnement simulateur (ADMIN uniquement) ──────────── */

  /** Crédit initial SIMULATION pour un compte client de test (50 000 XAF par
   *  défaut). Idempotent par utilisateur + mode : jamais créé deux fois, et
   *  jamais créé automatiquement à la connexion. Réservé ADMIN et
   *  EXCLUSIVEMENT au mode SIMULATION : en REAL, toute création artificielle
   *  est refusée (seule une recharge SasPay confirmée crédite le ledger). */
  async createTestCredit(actorUserId: string, targetUserId: string, amount: number) {
    if (this.getMode() !== 'SIMULATION') {
      throw new ForbiddenException(
        'Le crédit de test est désactivé en mode REAL : seul un paiement confirmé peut créditer le ledger.',
      );
    }
    if (amount <= 0) {
      throw new BadRequestException('Montant invalide pour un crédit de simulation.');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable.');
    if (target.role !== 'CLIENT') {
      throw new BadRequestException(
        'Le crédit initial de simulation est réservé aux comptes clients.',
      );
    }

    const mode: FinancialTransactionMode = 'SIMULATION';
    const reference = `initial-test-credit:${targetUserId}:${mode}`;

    const existing = await this.prisma.financialTransaction.findUnique({
      where: { reference },
    });
    if (existing) {
      const balance = await this.getClientBalance(targetUserId, mode);
      return {
        userId: targetUserId,
        created: false,
        alreadyCredited: true,
        transaction: {
          id: existing.id,
          amount: existing.amount,
          reference: existing.reference,
          createdAt: existing.createdAt.toISOString(),
        },
        balance,
      };
    }

    const txn = await this.prisma.$transaction(async (tx) => {
      return this.record(
        tx,
        {
          userId: targetUserId,
          demandeId: null,
          type: 'INITIAL_TEST_CREDIT',
          direction: 'CREDIT',
          amount,
          reference,
          createdById: actorUserId,
          metadata: { reason: 'Crédit initial simulateur', currency: FINANCIAL_CURRENCY },
        },
        { mode },
      );
    });

    const balance = await this.getClientBalance(targetUserId, mode);
    return {
      userId: targetUserId,
      created: true,
      alreadyCredited: false,
      transaction: {
        id: txn.id,
        amount: txn.amount,
        reference: txn.reference,
        createdAt: txn.createdAt.toISOString(),
      },
      balance,
    };
  }

  /* ── Fonds Relio + retraits ADMIN (Sprint ADMIN SUPER POWERS) ─── */
  /* Le portefeuille Relio n'est PAS un deuxième système financier : il est
   * calculé depuis le ledger existant.
   *   - commissions acquises = Σ TECHNICIAN_FEE (2 % du brut, au CONFIRMED)
   *     + Σ CLIENT_FEE legacy, écritures VALIDATED du mode serveur ;
   *   - une commission n'est acquise qu'après validation finale (CONFIRMED) :
   *     les missions non confirmées ne contribuent jamais au disponible ;
   *   - retraits = lignes RelioWithdrawal VALIDATED (chacune doublée d'une
   *     écriture ledger RELIO_WITHDRAWAL immuable) ;
   *   - disponible = acquises − retraits (jamais stocké, toujours calculé). */

  /** Synthèse des fonds Relio du mode serveur (SIMULATION par défaut). */
  async getRelioFunds() {
    const mode = this.getMode();
    return this.prisma.$transaction(async (tx) => this.computeRelioFunds(tx, mode));
  }

  /** Retrait des fonds Relio par un admin. Traçable : ligne RelioWithdrawal
   *  (référence UNIQUE RELIO-WD-…) + écriture ledger RELIO_WITHDRAWAL, dans
   *  la même transaction. Protections : montant > 0, montant ≤ disponible,
   *  verrou consultatif PostgreSQL contre les retraits concurrents (jamais
   *  de solde négatif), références uniques contre le double retrait. */
  async withdrawRelioFunds(adminId: string, amount: number, note?: string | null) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'Le montant du retrait doit être un entier XAF strictement positif.',
      );
    }
    const cleanNote = note?.trim() || null;
    if (cleanNote && cleanNote.length > RELIO_WITHDRAWAL_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `La note ne peut pas dépasser ${RELIO_WITHDRAWAL_NOTE_MAX_LENGTH} caractères.`,
      );
    }
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, role: true },
    });
    if (!admin || admin.role !== 'ADMIN') {
      throw new ForbiddenException('Seul un administrateur peut effectuer un retrait.');
    }

    const mode = this.getMode();
    return this.prisma.$transaction(async (tx) => {
      // Verrou consultatif de la transaction : sérialise les retraits
      // concurrents (deux retraits simultanés ne peuvent pas dépasser le
      // disponible ensemble).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('relio_withdrawal'))`;

      const funds = await this.computeRelioFunds(tx, mode);
      if (amount > funds.available) {
        throw new BadRequestException(
          `Retrait impossible : ${amount} XAF demandés pour ${funds.available} XAF disponibles.`,
        );
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const reference = generateRelioWithdrawalReference();
        try {
          const withdrawal = await tx.relioWithdrawal.create({
            data: {
              reference,
              amount,
              note: cleanNote,
              mode,
              payoutStatus: 'SUCCESS',
              requestedById: adminId,
            },
            include: {
              requestedBy: { select: { id: true, firstName: true, lastName: true } },
            },
          });
          await this.record(
            tx,
            {
              userId: adminId,
              demandeId: null,
              type: 'RELIO_WITHDRAWAL',
              direction: 'DEBIT',
              amount,
              reference: `relio-withdrawal-ledger:${withdrawal.id}:${mode}`,
              createdById: adminId,
              metadata: {
                withdrawalId: withdrawal.id,
                withdrawalReference: reference,
                note: cleanNote,
                currency: FINANCIAL_CURRENCY,
              },
            },
            { mode },
          );
          return {
            ...toApiRelioWithdrawal(withdrawal),
            availableAfter: funds.available - amount,
          };
        } catch (error) {
          // Collision sur la référence générée : on regénère (P2002).
          if ((error as { code?: string }).code === 'P2002') continue;
          throw error;
        }
      }
      throw new Error('Impossible de générer une référence de retrait unique. Réessayez.');
    });
  }

  /** Historique des retraits Relio (traçabilité : date, montant, admin,
   *  référence, statut). */
  async listRelioWithdrawals() {
    const rows = await this.prisma.relioWithdrawal.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        requestedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return { items: rows.map(toApiRelioWithdrawal) };
  }

  private async computeRelioFunds(tx: Tx, mode: FinancialTransactionMode) {
    // Seuls les retraits payoutStatus = SUCCESS réduisent le disponible :
    // un payout PENDING n'est jamais un SUCCESS (fondations SASPAY-01).
    // Les lignes historiques portent SUCCESS par défaut (migration).
    const [technicianFees, clientFees, withdrawals, withdrawalsCount] = await Promise.all([
      tx.financialTransaction.aggregate({
        where: { mode, status: 'VALIDATED', type: 'TECHNICIAN_FEE', direction: 'DEBIT' },
        _sum: { amount: true },
      }),
      tx.financialTransaction.aggregate({
        where: { mode, status: 'VALIDATED', type: 'CLIENT_FEE', direction: 'DEBIT' },
        _sum: { amount: true },
      }),
      tx.relioWithdrawal.aggregate({
        where: { mode, status: 'VALIDATED', payoutStatus: 'SUCCESS' },
        _sum: { amount: true },
      }),
      tx.relioWithdrawal.count({ where: { mode, status: 'VALIDATED', payoutStatus: 'SUCCESS' } }),
    ]);
    const acquired = (technicianFees._sum.amount ?? 0) + (clientFees._sum.amount ?? 0);
    const withdrawn = withdrawals._sum.amount ?? 0;
    return {
      mode,
      currency: FINANCIAL_CURRENCY,
      acquired,
      withdrawn,
      available: acquired - withdrawn,
      withdrawalsCount,
    };
  }

  /* ── Fondations SasPay (Sprint SASPAY-01) ─────────────────────── */
  /* Le ledger FinancialTransaction reste l'UNIQUE source de vérité :
   *  - TopupIntent / WithdrawalRequest / FundsHold ne portent aucun solde ;
   *  - disponible = Σ ledger VALIDATED − Σ holds ACTIVE (calculé) ;
   *  - toute lecture + réservation/débit concurrente passe sous verrou
   *    consultatif PostgreSQL par utilisateur (même pattern que
   *    withdrawRelioFunds, transposé à la granularité utilisateur) ;
   *  - le ledger n'est crédité/débité qu'après confirmation serveur fiable
   *    (webhook), jamais sur indication du frontend. */

  /** Verrou consultatif de transaction, par utilisateur : sérialise
   *  lecture du disponible + réservation/débit concurrents (anti-TOCTOU).
   *  Même pattern que `withdrawRelioFunds()`, granularité utilisateur. */
  private async lockUserFunds(tx: Tx, userId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user_funds:${userId}`}))`;
  }

  /** Solde ledger brut d'un utilisateur (sans déduire les holds). */
  private async ledgerBalance(tx: Tx, userId: string, mode: FinancialTransactionMode) {
    const [credits, debits] = await Promise.all([
      tx.financialTransaction.aggregate({
        where: { userId, mode, status: 'VALIDATED', direction: 'CREDIT' },
        _sum: { amount: true },
      }),
      tx.financialTransaction.aggregate({
        where: { userId, mode, status: 'VALIDATED', direction: 'DEBIT' },
        _sum: { amount: true },
      }),
    ]);
    return (credits._sum.amount ?? 0) - (debits._sum.amount ?? 0);
  }

  /** Montant total gelé par les holds ACTIVE d'un utilisateur (mode donné). */
  async getReservedAmount(
    userId: string,
    mode: FinancialTransactionMode,
    tx?: Tx,
  ): Promise<number> {
    const client: Tx = tx ?? (this.prisma as unknown as Tx);
    const holds = await client.fundsHold.aggregate({
      where: { userId, mode, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    return holds._sum.amount ?? 0;
  }

  /** Disponible réel = ledger − holds ACTIVE. Jamais stocké, toujours
   *  calculé. À appeler SOUS `lockUserFunds` quand une réservation suit. */
  async getAvailableBalance(
    userId: string,
    mode: FinancialTransactionMode,
    tx?: Tx,
  ): Promise<number> {
    const client: Tx = tx ?? (this.prisma as unknown as Tx);
    const [ledger, reserved] = await Promise.all([
      this.ledgerBalance(client, userId, mode),
      this.getReservedAmount(userId, mode, client),
    ]);
    return ledger - reserved;
  }

  /** Réserve un montant du disponible (hold ACTIVE idempotent par
   *  `reference`). Lève 400 si le disponible (sous verrou) est insuffisant.
   *  Ne crée AUCUNE écriture ledger : le hold est un verrou logique. */
  async reserveFunds(
    userId: string,
    amount: number,
    options: {
      reference?: string;
      demandeId?: string | null;
      createdById?: string | null;
      metadata?: Prisma.InputJsonObject | null;
      mode?: FinancialTransactionMode;
    } = {},
  ) {
    assertPositiveInteger(amount, 'Le montant réservé');
    const mode = options.mode ?? this.getMode();
    const reference =
      options.reference ??
      (options.demandeId
        ? `hold:${options.demandeId}:${userId}:${mode}`
        : generateFundsHoldReference());
    return this.prisma.$transaction(async (tx) => {
      await this.lockUserFunds(tx, userId);
      const existing = await tx.fundsHold.findUnique({ where: { reference } });
      if (existing) return existing;
      const available = await this.getAvailableBalance(userId, mode, tx);
      if (amount > available) {
        throw new BadRequestException(
          `Fonds insuffisants : ${amount} XAF demandés pour ${available} XAF disponibles.`,
        );
      }
      try {
        return await tx.fundsHold.create({
          data: {
            reference,
            userId,
            demandeId: options.demandeId ?? null,
            amount,
            currency: FINANCIAL_CURRENCY,
            mode,
            status: 'ACTIVE',
            metadata: options.metadata ?? Prisma.JsonNull,
            createdById: options.createdById ?? null,
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const concurrent = await tx.fundsHold.findUnique({ where: { reference } });
          if (concurrent) return concurrent;
        }
        throw error;
      }
    });
  }

  /** Libère un hold ACTIVE (échec/annulation) : fonds rendus au disponible.
   *  Idempotent : un hold déjà RELEASED/CONSUMED est retourné tel quel. */
  async releaseHold(reference: string) {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.fundsHold.findUnique({ where: { reference } });
      if (!hold) throw new NotFoundException('Réservation introuvable.');
      if (hold.status !== 'ACTIVE') return hold;
      await this.lockUserFunds(tx, hold.userId);
      const fresh = await tx.fundsHold.findUnique({ where: { reference } });
      if (!fresh || fresh.status !== 'ACTIVE') return fresh ?? hold;
      return tx.fundsHold.update({
        where: { reference },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
    });
  }

  /** Consomme un hold ACTIVE (opération définitive, débit ledger à part).
   *  Idempotent : un hold déjà CONSUMED est retourné tel quel. */
  async consumeHold(reference: string) {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.fundsHold.findUnique({ where: { reference } });
      if (!hold) throw new NotFoundException('Réservation introuvable.');
      if (hold.status !== 'ACTIVE') return hold;
      await this.lockUserFunds(tx, hold.userId);
      const fresh = await tx.fundsHold.findUnique({ where: { reference } });
      if (!fresh || fresh.status !== 'ACTIVE') return fresh ?? hold;
      return tx.fundsHold.update({
        where: { reference },
        data: { status: 'CONSUMED', releasedAt: new Date() },
      });
    });
  }

  /* ── Intentions de recharge (TopupIntent) ─────────────────────── */
  /* Création = PENDING, sans écriture ledger. Confirmation = SUCCESS +
   * CLIENT_TOPUP CREDIT, idempotente et transactionnelle (rejouabilité
   * webhook : même appel répété = aucun nouveau crédit). */

  /** Crée une intention de recharge PENDING (aucun crédit ledger).
   *  Idempotente par `idempotencyKey` : rejouer la même clé retourne
   *  l'intention existante. Réservée aux comptes CLIENT. Le réseau/téléphone
   *  (pay-in SasPay) sont validés côté backend et conservés (colonnes +
   *  metadata) pour l'initialisation ; le frontend ne choisit jamais hors
   *  référentiel. */
  async createTopupIntent(
    actorUserId: string,
    targetUserId: string,
    amount: number,
    options: {
      idempotencyKey?: string;
      metadata?: Prisma.InputJsonObject | null;
      network?: string | null;
      phone?: string | null;
    } = {},
  ) {
    assertTopupAmount(amount);
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable.');
    if (target.role !== 'CLIENT') {
      throw new BadRequestException('La recharge est réservée aux comptes clients.');
    }
    const network = options.network ?? null;
    if (network !== null && !isSupportedTopupNetwork(network)) {
      throw new BadRequestException(
        `Réseau non supporté pour la recharge (attendu : ${SASPAY_TOPUP_NETWORKS.join(', ')}).`,
      );
    }
    const phone = options.phone !== undefined ? normalizeMsisdn(options.phone) : null;
    if (options.phone !== undefined && options.phone !== null && phone === null) {
      throw new BadRequestException('Numéro de téléphone invalide pour la recharge.');
    }
    const mode = this.getMode();
    const idempotencyKey = sanitizeIdempotencyKey(options.idempotencyKey) ?? randomUUID();
    const existingByKey = await this.prisma.topupIntent.findUnique({
      where: { idempotencyKey },
    });
    if (existingByKey) return toApiTopupIntent(existingByKey);

    const baseMetadata =
      options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata)
        ? { ...(options.metadata as Record<string, unknown>) }
        : {};
    if (phone) baseMetadata.phone = phone;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = generateTopupReference();
      try {
        const created = await this.prisma.topupIntent.create({
          data: {
            reference,
            idempotencyKey,
            userId: targetUserId,
            amount,
            currency: FINANCIAL_CURRENCY,
            mode,
            status: 'PENDING',
            requestedAmount: amount,
            network,
            country: network ? SASPAY_TOPUP_COUNTRY : null,
            metadata:
              Object.keys(baseMetadata).length > 0
                ? (baseMetadata as Prisma.InputJsonObject)
                : (options.metadata ?? Prisma.JsonNull),
            createdById: actorUserId,
          },
        });
        return toApiTopupIntent(created);
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const byKey = await this.prisma.topupIntent.findUnique({
            where: { idempotencyKey },
          });
          if (byKey) return toApiTopupIntent(byKey);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Impossible de créer une intention de recharge unique. Réessayez.');
  }

  /** Confirme une intention PENDING après paiement fiable (webhook serveur) :
   *  CLIENT_TOPUP CREDIT + passage SUCCESS, dans la même transaction.
   *  Idempotente : intention déjà SUCCESS = retour sans nouveau crédit ;
   *  saspayTransactionId déjà consommé par une autre intention = 409.
   *  Le montant crédité est le net constaté s'il est fourni et valide,
   *  sinon le montant demandé (jamais de confiance au frontend : cet appel
   *  est réservé au traitement webhook/serveur).
   *  Depuis SASPAY-03, un SUCCESS tardif sur intention FAILED/CANCELLED
   *  (argent réellement arrivé) crédite une seule fois s'il n'existe aucun
   *  crédit ; un SUCCESS existant ne bascule jamais vers un autre statut. */
  async confirmTopupIntent(
    reference: string,
    saspay: {
      saspayTransactionId?: string | null;
      saspayReference?: string | null;
      externalReference?: string | null;
      network?: string | null;
      country?: string | null;
      fee?: number | null;
      chargedAmount?: number | null;
      netAmount?: number | null;
    } = {},
  ) {
    const mode = this.getMode();
    return this.prisma.$transaction(async (tx) => {
      const intent = await tx.topupIntent.findUnique({ where: { reference } });
      if (!intent) throw new NotFoundException('Intention de recharge introuvable.');
      if (intent.mode !== mode) {
        throw new ForbiddenException(
          `Intention en mode « ${intent.mode} » (mode serveur actuel : ${mode}).`,
        );
      }
      if (intent.status === 'SUCCESS') {
        const credited = intent.creditedTransactionId
          ? await tx.financialTransaction.findUnique({
              where: { id: intent.creditedTransactionId },
            })
          : null;
        return { intent: toApiTopupIntent(intent), credited: false, transaction: credited };
      }
      if (intent.status !== 'PENDING' && intent.creditedTransactionId) {
        // Garde-fou : un crédit existe déjà — jamais de second crédit,
        // même face à un SUCCESS tardif.
        throw new ConflictException(
          'Recharge déjà créditée : aucune nouvelle écriture.',
        );
      }
      if (intent.status !== 'PENDING') {
        this.logger.warn(
          `SUCCESS tardif sur intention ${intent.reference} (statut ${intent.status}) : crédit unique appliqué.`,
        );
      }
      const creditAmount =
        saspay.netAmount !== null &&
        saspay.netAmount !== undefined &&
        Number.isInteger(saspay.netAmount) &&
        saspay.netAmount > 0
          ? saspay.netAmount
          : intent.amount;
      return this.finalizeTopupSuccessTx(tx, intent, mode, {
        creditAmount,
        saspayTransactionId: saspay.saspayTransactionId ?? null,
        saspayReference: saspay.saspayReference ?? null,
        externalReference: saspay.externalReference ?? null,
        network: saspay.network ?? null,
        country: saspay.country ?? null,
        fee: saspay.fee ?? null,
        chargedAmount: saspay.chargedAmount ?? null,
      });
    });
  }

  /** Confirmation serveur d'un paiement SasPay (webhook transaction.success
   *  ou vérification GET /payments/{id}/verify/) avec contrôles comptables
   *  stricts, avant tout crédit :
   *    - intention retrouvée par référence Relio ou par transaction SasPay ;
   *    - devise fournie = devise de l'intention (sinon FAILED, 0 crédit) ;
   *    - montant demandé fourni = montant de l'intention (sinon FAILED) ;
   *    - net constaté entier > 0 (sinon FAILED) — jamais `amount` seul :
   *      le ledger crédite le NET (ADD_ON : net = amount ; DEDUCTED :
   *      net = amount − fee), jamais de frais hardcodés ;
   *    - SUCCESS existant : retour idempotent, jamais re-crédité ni muté ;
   *    - FAILED/CANCELLED sans crédit + SUCCESS vérifié tardif : crédit
   *      unique autorisé (l'argent est réellement arrivé).
   *  Tout est atomique (verrou utilisateur + transaction). */
  async confirmTopupFromSasPay(input: {
    intentReference?: string | null;
    saspayTransactionId?: string | null;
    currency?: string | null;
    requestedAmountMinor?: number | null;
    netAmountMinor?: number | null;
    chargedAmountMinor?: number | null;
    feeMinor?: number | null;
    feeChargeMode?: string | null;
    saspayReference?: string | null;
    externalReference?: string | null;
    network?: string | null;
    country?: string | null;
  }) {
    const mode = this.getMode();
    return this.prisma.$transaction(async (tx) => {
      const intent = input.intentReference
        ? await tx.topupIntent.findUnique({ where: { reference: input.intentReference } })
        : input.saspayTransactionId
          ? await tx.topupIntent.findFirst({
              where: { saspayTransactionId: input.saspayTransactionId },
            })
          : null;
      if (!intent) throw new NotFoundException('Intention de recharge introuvable.');
      if (intent.mode !== mode) {
        throw new ForbiddenException(
          `Intention en mode « ${intent.mode} » (mode serveur actuel : ${mode}).`,
        );
      }
      if (intent.status === 'SUCCESS') {
        const credited = intent.creditedTransactionId
          ? await tx.financialTransaction.findUnique({
              where: { id: intent.creditedTransactionId },
            })
          : null;
        return { intent: toApiTopupIntent(intent), credited: false, transaction: credited };
      }
      if (intent.creditedTransactionId) {
        throw new ConflictException('Recharge déjà créditée : aucune nouvelle écriture.');
      }

      const fail = async (code: string, message: string): Promise<never> => {
        if (intent.status === 'PENDING') {
          await tx.topupIntent.update({
            where: { id: intent.id },
            data: {
              status: 'FAILED',
              errorMessage: `${code} — ${message}`.slice(0, 500),
              saspayTransactionId: input.saspayTransactionId ?? intent.saspayTransactionId,
              saspayReference: input.saspayReference ?? intent.saspayReference,
              externalReference: input.externalReference ?? intent.externalReference,
            },
          });
        }
        throw new ConflictException(`${code} — ${message}`);
      };

      if (input.currency && input.currency.toUpperCase() !== intent.currency.toUpperCase()) {
        await fail('DEVISE_INATTENDUE', `devise ${input.currency} pour une intention ${intent.currency}`);
      }
      if (
        input.requestedAmountMinor !== null &&
        input.requestedAmountMinor !== undefined &&
        input.requestedAmountMinor !== intent.amount
      ) {
        await fail(
          'MONTANT_INATTENDU',
          `montant demandé ${input.requestedAmountMinor} pour une intention de ${intent.amount}`,
        );
      }
      if (
        input.netAmountMinor === null ||
        input.netAmountMinor === undefined ||
        !Number.isInteger(input.netAmountMinor) ||
        input.netAmountMinor <= 0
      ) {
        await fail('NET_MANQUANT', 'montant net SasPay absent ou invalide : aucun crédit');
      }
      if (intent.status !== 'PENDING') {
        this.logger.warn(
          `SUCCESS tardif sur intention ${intent.reference} (statut ${intent.status}) : crédit unique appliqué.`,
        );
      }
      return this.finalizeTopupSuccessTx(tx, intent, mode, {
        creditAmount: input.netAmountMinor as number,
        saspayTransactionId: input.saspayTransactionId ?? null,
        saspayReference: input.saspayReference ?? null,
        externalReference: input.externalReference ?? null,
        network: input.network ?? null,
        country: input.country ?? null,
        fee: input.feeMinor ?? null,
        chargedAmount: input.chargedAmountMinor ?? null,
        extraMetadata:
          input.feeChargeMode != null ? { feeChargeMode: input.feeChargeMode } : undefined,
      });
    });
  }

  /** Finalise un SUCCESS : verrou, anti-double-consommation par transaction
   *  SasPay, CLIENT_TOPUP CREDIT idempotent, intention SUCCESS — atomique.
   *  Le crédit existe au plus une fois par intention (`reference` ledger
   *  déterministe + `record()` idempotent). */
  private async finalizeTopupSuccessTx(
    tx: Tx,
    intent: {
      id: string;
      reference: string;
      userId: string;
      amount: number;
      createdById: string | null;
      saspayTransactionId: string | null;
      saspayReference: string | null;
      externalReference: string | null;
      network: string | null;
      country: string | null;
      fee: number | null;
      chargedAmount: number | null;
    },
    mode: FinancialTransactionMode,
    saspay: {
      creditAmount: number;
      saspayTransactionId?: string | null;
      saspayReference?: string | null;
      externalReference?: string | null;
      network?: string | null;
      country?: string | null;
      fee?: number | null;
      chargedAmount?: number | null;
      extraMetadata?: Record<string, unknown>;
    },
  ) {
    if (saspay.saspayTransactionId) {
      const alreadyUsed = await tx.topupIntent.findFirst({
        where: {
          saspayTransactionId: saspay.saspayTransactionId,
          status: 'SUCCESS',
          id: { not: intent.id },
        },
        select: { id: true },
      });
      if (alreadyUsed) {
        throw new ConflictException('Transaction SasPay déjà consommée par une autre recharge.');
      }
    }
    await this.lockUserFunds(tx, intent.userId);

    const ledgerReference = `client-topup:${intent.id}:${mode}`;
    const entry = await this.record(
      tx,
      {
        userId: intent.userId,
        demandeId: null,
        type: 'CLIENT_TOPUP',
        direction: 'CREDIT',
        amount: saspay.creditAmount,
        reference: ledgerReference,
        createdById: intent.createdById,
        metadata: {
          topupIntentId: intent.id,
          topupReference: intent.reference,
          requestedAmount: intent.amount,
          netAmount: saspay.creditAmount,
          chargedAmount: saspay.chargedAmount ?? null,
          fee: saspay.fee ?? null,
          saspayTransactionId: saspay.saspayTransactionId ?? null,
          saspayReference: saspay.saspayReference ?? null,
          currency: FINANCIAL_CURRENCY,
          ...saspay.extraMetadata,
        },
      },
      { mode },
    );
    const updated = await tx.topupIntent.update({
      where: { id: intent.id },
      data: {
        status: 'SUCCESS',
        saspayTransactionId: saspay.saspayTransactionId ?? intent.saspayTransactionId,
        saspayReference: saspay.saspayReference ?? intent.saspayReference,
        externalReference: saspay.externalReference ?? intent.externalReference,
        network: saspay.network ?? intent.network,
        country: saspay.country ?? intent.country,
        fee: saspay.fee ?? intent.fee,
        chargedAmount: saspay.chargedAmount ?? intent.chargedAmount,
        netAmount: saspay.creditAmount,
        creditedTransactionId: entry.id,
      },
    });
    return { intent: toApiTopupIntent(updated), credited: true, transaction: entry };
  }

  /** Marque une intention PENDING en FAILED (aucune écriture ledger).
   *  Idempotente et terminale : un SUCCESS existant n'est JAMAIS muté par
   *  un événement tardif (retourné tel quel avec avertissement). */
  async failTopupIntent(reference: string, errorMessage?: string | null) {
    const intent = await this.prisma.topupIntent.findUnique({ where: { reference } });
    if (!intent) throw new NotFoundException('Intention de recharge introuvable.');
    if (intent.status === 'SUCCESS') {
      this.logger.warn(
        `Événement d'échec ignoré sur intention SUCCESS ${intent.reference} : statut terminal protégé.`,
      );
      return toApiTopupIntent(intent);
    }
    if (intent.status !== 'PENDING') return toApiTopupIntent(intent);
    const updated = await this.prisma.topupIntent.update({
      where: { reference },
      data: { status: 'FAILED', errorMessage: errorMessage?.slice(0, 500) ?? null },
    });
    return toApiTopupIntent(updated);
  }

  /** Annule une intention PENDING (aucune écriture ledger). Idempotente et
   *  terminale : un SUCCESS existant n'est JAMAIS muté. */
  async cancelTopupIntent(reference: string) {
    const intent = await this.prisma.topupIntent.findUnique({ where: { reference } });
    if (!intent) throw new NotFoundException('Intention de recharge introuvable.');
    if (intent.status === 'SUCCESS') {
      this.logger.warn(
        `Événement d'annulation ignoré sur intention SUCCESS ${intent.reference} : statut terminal protégé.`,
      );
      return toApiTopupIntent(intent);
    }
    if (intent.status !== 'PENDING') return toApiTopupIntent(intent);
    const updated = await this.prisma.topupIntent.update({
      where: { reference },
      data: { status: 'CANCELLED' },
    });
    return toApiTopupIntent(updated);
  }

  /** Intentions de recharge d'un utilisateur (traçabilité, lecture seule). */
  async listTopupIntents(userId: string) {
    const rows = await this.prisma.topupIntent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map(toApiTopupIntent) };
  }

  /** Rattache un échec SasPay à l'intention (référence Relio ou transaction
   *  SasPay) puis applique `failTopupIntent` (SUCCESS terminal jamais muté).
   *  Utilisé par le webhook `transaction.failed` et la vérification serveur. */
  async failTopupFromSasPay(input: {
    intentReference?: string | null;
    saspayTransactionId?: string | null;
    reason?: string | null;
  }) {
    const reference = await this.resolveTopupReference(input);
    return this.failTopupIntent(reference, input.reason ?? null);
  }

  /** Rattache une annulation SasPay à l'intention puis applique
   *  `cancelTopupIntent` (SUCCESS terminal jamais muté). */
  async cancelTopupFromSasPay(input: {
    intentReference?: string | null;
    saspayTransactionId?: string | null;
  }) {
    const reference = await this.resolveTopupReference(input);
    return this.cancelTopupIntent(reference);
  }

  private async resolveTopupReference(input: {
    intentReference?: string | null;
    saspayTransactionId?: string | null;
  }): Promise<string> {
    if (input.intentReference) return input.intentReference;
    if (input.saspayTransactionId) {
      const found = await this.prisma.topupIntent.findFirst({
        where: { saspayTransactionId: input.saspayTransactionId },
        select: { reference: true },
      });
      if (found) return found.reference;
    }
    throw new NotFoundException('Transaction SasPay inconnue (aucune intention rattachée).');
  }
  /** Intention du seul propriétaire (userId JWT). Null si absente ou à un
   *  autre utilisateur, sans distinguer les deux cas. */
  async getTopupIntentForOwner(userId: string, reference: string) {
    const intent = await this.prisma.topupIntent.findUnique({ where: { reference } });
    if (!intent || intent.userId !== userId) return null;
    return toApiTopupIntent(intent);
  }

  /* ── Demandes de retrait client/technicien ────────────────────── */
  /* Création = hold ACTIVE + demande PENDING (aucun débit). SUCCESS =
   * débit ledger définitif + hold CONSUMED. FAILED/CANCELLED = hold
   * RELEASED, fonds libérés, aucune écriture. PENDING ≠ SUCCESS. */

  /** Crée une demande de retrait PENDING + hold ACTIVE, sous verrou
   *  utilisateur (disponible ≥ montant vérifié atomiquement).
   *  Idempotente par `idempotencyKey`. */
  async createWithdrawalRequest(
    actorUserId: string,
    targetUserId: string,
    amount: number,
    options: { idempotencyKey?: string; metadata?: Prisma.InputJsonObject | null } = {},
  ) {
    assertWithdrawalAmount(amount);
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable.');
    if (target.role !== 'CLIENT' && target.role !== 'TECHNICIAN') {
      throw new BadRequestException(
        'Les retraits sont réservés aux comptes clients et techniciens.',
      );
    }
    const mode = this.getMode();
    const idempotencyKey = sanitizeIdempotencyKey(options.idempotencyKey) ?? randomUUID();
    const existingByKey = await this.prisma.withdrawalRequest.findUnique({
      where: { idempotencyKey },
    });
    if (existingByKey) return toApiWithdrawalRequest(existingByKey);

    return this.prisma.$transaction(async (tx) => {
      await this.lockUserFunds(tx, targetUserId);
      const duplicate = await tx.withdrawalRequest.findUnique({
        where: { idempotencyKey },
      });
      if (duplicate) return toApiWithdrawalRequest(duplicate);
      const available = await this.getAvailableBalance(targetUserId, mode, tx);
      if (amount > available) {
        throw new BadRequestException(
          `Fonds insuffisants : ${amount} XAF demandés pour ${available} XAF disponibles.`,
        );
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const reference = generateWithdrawalRequestReference();
        const holdReference = generateFundsHoldReference();
        try {
          const hold = await tx.fundsHold.create({
            data: {
              reference: holdReference,
              userId: targetUserId,
              amount,
              currency: FINANCIAL_CURRENCY,
              mode,
              status: 'ACTIVE',
              metadata: { withdrawalReference: reference },
              createdById: actorUserId,
            },
          });
          const created = await tx.withdrawalRequest.create({
            data: {
              reference,
              idempotencyKey,
              userId: targetUserId,
              amount,
              currency: FINANCIAL_CURRENCY,
              mode,
              status: 'PENDING',
              holdId: hold.id,
              requestedAmount: amount,
              metadata: options.metadata ?? Prisma.JsonNull,
              createdById: actorUserId,
            },
          });
          return toApiWithdrawalRequest(created);
        } catch (error) {
          if ((error as { code?: string }).code === 'P2002') {
            const byKey = await tx.withdrawalRequest.findUnique({
              where: { idempotencyKey },
            });
            if (byKey) return toApiWithdrawalRequest(byKey);
            continue;
          }
          throw error;
        }
      }
      throw new Error('Impossible de créer une demande de retrait unique. Réessayez.');
    });
  }

  /** Règle un payout réussi : débit ledger définitif + hold CONSUMED +
   *  demande SUCCESS, dans la même transaction. Idempotent : une demande
   *  déjà SUCCESS est retournée sans nouveau débit. */
  async settleWithdrawalSuccess(
    reference: string,
    saspay: {
      saspayTransactionId?: string | null;
      saspayReference?: string | null;
      externalReference?: string | null;
      network?: string | null;
      country?: string | null;
      fee?: number | null;
      chargedAmount?: number | null;
      netAmount?: number | null;
    } = {},
  ) {
    const mode = this.getMode();
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { reference } });
      if (!request) throw new NotFoundException('Demande de retrait introuvable.');
      if (request.mode !== mode) {
        throw new ForbiddenException(
          `Demande en mode « ${request.mode} » (mode serveur actuel : ${mode}).`,
        );
      }
      if (request.status === 'SUCCESS') {
        return { request: toApiWithdrawalRequest(request), debited: false };
      }
      if (request.status !== 'PENDING') {
        throw new ConflictException(
          `Demande déjà traitée (statut « ${request.status} ») : aucune nouvelle écriture.`,
        );
      }
      const owner = await tx.user.findUnique({
        where: { id: request.userId },
        select: { id: true, role: true },
      });
      if (!owner) throw new NotFoundException('Utilisateur introuvable.');
      const type = owner.role === 'TECHNICIAN' ? 'TECHNICIAN_WITHDRAWAL' : 'CLIENT_WITHDRAWAL';
      await this.lockUserFunds(tx, request.userId);
      const ledgerReference = `withdrawal:${request.id}:${mode}`;
      await this.record(
        tx,
        {
          userId: request.userId,
          demandeId: null,
          type,
          direction: 'DEBIT',
          amount: request.amount,
          reference: ledgerReference,
          createdById: request.createdById,
          metadata: {
            withdrawalRequestId: request.id,
            withdrawalReference: request.reference,
            saspayTransactionId: saspay.saspayTransactionId ?? null,
            saspayReference: saspay.saspayReference ?? null,
            currency: FINANCIAL_CURRENCY,
          },
        },
        { mode },
      );
      if (request.holdId) {
        await tx.fundsHold.updateMany({
          where: { id: request.holdId, status: 'ACTIVE' },
          data: { status: 'CONSUMED', releasedAt: new Date() },
        });
      }
      const updated = await tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: 'SUCCESS',
          ledgerReference,
          saspayTransactionId: saspay.saspayTransactionId ?? request.saspayTransactionId,
          saspayReference: saspay.saspayReference ?? request.saspayReference,
          externalReference: saspay.externalReference ?? request.externalReference,
          network: saspay.network ?? request.network,
          country: saspay.country ?? request.country,
          fee: saspay.fee ?? request.fee,
          chargedAmount: saspay.chargedAmount ?? request.chargedAmount,
          netAmount: saspay.netAmount ?? request.netAmount,
        },
      });
      return { request: toApiWithdrawalRequest(updated), debited: true };
    });
  }

  /** Règle un payout échoué/annulé : hold RELEASED (fonds libérés), demande
   *  FAILED/CANCELLED, AUCUNE écriture ledger. Idempotent. */
  async settleWithdrawalFailure(
    reference: string,
    outcome: 'FAILED' | 'CANCELLED',
    errorMessage?: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.withdrawalRequest.findUnique({ where: { reference } });
      if (!request) throw new NotFoundException('Demande de retrait introuvable.');
      if (request.status !== 'PENDING') {
        return toApiWithdrawalRequest(request);
      }
      await this.lockUserFunds(tx, request.userId);
      if (request.holdId) {
        await tx.fundsHold.updateMany({
          where: { id: request.holdId, status: 'ACTIVE' },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
      }
      const updated = await tx.withdrawalRequest.update({
        where: { id: request.id },
        data: { status: outcome, errorMessage: errorMessage?.slice(0, 500) ?? null },
      });
      return toApiWithdrawalRequest(updated);
    });
  }

  /** Demandes de retrait d'un utilisateur (traçabilité, lecture seule). */
  async listWithdrawalRequests(userId: string) {
    const rows = await this.prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map(toApiWithdrawalRequest) };
  }
}

export function generateRelioWithdrawalReference(): string {
  let reference = RELIO_WITHDRAWAL_REFERENCE_PREFIX;
  for (let i = 0; i < RELIO_WITHDRAWAL_REFERENCE_LENGTH; i += 1) {
    reference +=
      RELIO_WITHDRAWAL_REFERENCE_ALPHABET[randomInt(RELIO_WITHDRAWAL_REFERENCE_ALPHABET.length)];
  }
  return reference;
}

/* ── Fondations SasPay : références, sérialiseurs, garde-fous ─────── */

function randomSuffix(length: number): string {
  let suffix = '';
  for (let i = 0; i < length; i += 1) {
    suffix += FINANCIAL_REFERENCE_ALPHABET[randomInt(FINANCIAL_REFERENCE_ALPHABET.length)];
  }
  return suffix;
}

/** Référence interne d'intention de recharge (TOPUP-…, UNIQUE). */
export function generateTopupReference(): string {
  return `${TOPUP_INTENT_REFERENCE_PREFIX}${randomSuffix(TOPUP_INTENT_REFERENCE_LENGTH)}`;
}

/** Référence interne de demande de retrait (WD-…, UNIQUE). */
export function generateWithdrawalRequestReference(): string {
  return `${WITHDRAWAL_REQUEST_REFERENCE_PREFIX}${randomSuffix(WITHDRAWAL_REQUEST_REFERENCE_LENGTH)}`;
}

/** Référence interne de réservation (HOLD-…, UNIQUE). */
export function generateFundsHoldReference(): string {
  return `${FUNDS_HOLD_REFERENCE_PREFIX}${randomSuffix(FUNDS_HOLD_REFERENCE_LENGTH)}`;
}

function sanitizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new BadRequestException(
      `La clé d'idempotence ne peut pas dépasser ${IDEMPOTENCY_KEY_MAX_LENGTH} caractères.`,
    );
  }
  return clean;
}

function assertPositiveInteger(amount: number, label: string) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BadRequestException(`Le montant ${label.toLowerCase()} doit être un entier XAF strictement positif.`);
  }
}

function assertTopupAmount(amount: number) {
  assertPositiveInteger(amount, 'de la recharge');
  if (amount < MIN_TOPUP_AMOUNT || amount > MAX_TOPUP_AMOUNT) {
    throw new BadRequestException(
      `Le montant de recharge doit être compris entre ${MIN_TOPUP_AMOUNT} et ${MAX_TOPUP_AMOUNT} XAF.`,
    );
  }
}

function assertWithdrawalAmount(amount: number) {
  assertPositiveInteger(amount, 'du retrait');
  if (amount < MIN_WITHDRAWAL_AMOUNT || amount > MAX_WITHDRAWAL_AMOUNT) {
    throw new BadRequestException(
      `Le montant de retrait doit être compris entre ${MIN_WITHDRAWAL_AMOUNT} et ${MAX_WITHDRAWAL_AMOUNT} XAF.`,
    );
  }
}

function toApiTopupIntent(intent: {
  id: string;
  reference: string;
  userId: string;
  amount: number;
  currency: string;
  mode: string;
  status: SasPayOperationStatus | string;
  saspayTransactionId: string | null;
  saspayReference: string | null;
  externalReference: string | null;
  network: string | null;
  country: string | null;
  requestedAmount: number | null;
  fee: number | null;
  chargedAmount: number | null;
  netAmount: number | null;
  creditedTransactionId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: intent.id,
    reference: intent.reference,
    userId: intent.userId,
    amount: intent.amount,
    currency: intent.currency,
    mode: intent.mode,
    status: intent.status,
    saspayTransactionId: intent.saspayTransactionId,
    saspayReference: intent.saspayReference,
    externalReference: intent.externalReference,
    network: intent.network,
    country: intent.country,
    requestedAmount: intent.requestedAmount,
    fee: intent.fee,
    chargedAmount: intent.chargedAmount,
    netAmount: intent.netAmount,
    creditedTransactionId: intent.creditedTransactionId,
    errorMessage: intent.errorMessage,
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
  };
}

function toApiWithdrawalRequest(request: {
  id: string;
  reference: string;
  userId: string;
  amount: number;
  currency: string;
  mode: string;
  status: SasPayOperationStatus | string;
  holdId: string | null;
  ledgerReference: string | null;
  saspayTransactionId: string | null;
  saspayReference: string | null;
  externalReference: string | null;
  network: string | null;
  country: string | null;
  requestedAmount: number | null;
  fee: number | null;
  chargedAmount: number | null;
  netAmount: number | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: request.id,
    reference: request.reference,
    userId: request.userId,
    amount: request.amount,
    currency: request.currency,
    mode: request.mode,
    status: request.status,
    holdId: request.holdId,
    ledgerReference: request.ledgerReference,
    saspayTransactionId: request.saspayTransactionId,
    saspayReference: request.saspayReference,
    externalReference: request.externalReference,
    network: request.network,
    country: request.country,
    requestedAmount: request.requestedAmount,
    fee: request.fee,
    chargedAmount: request.chargedAmount,
    netAmount: request.netAmount,
    errorMessage: request.errorMessage,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function toApiRelioWithdrawal(withdrawal: {
  id: string;
  reference: string;
  amount: number;
  note: string | null;
  mode: FinancialTransactionMode;
  status: string;
  requestedBy: { id: string; firstName: string; lastName: string | null };
  createdAt: Date;
}) {
  return {
    id: withdrawal.id,
    reference: withdrawal.reference,
    amount: withdrawal.amount,
    note: withdrawal.note,
    mode: withdrawal.mode,
    status: withdrawal.status,
    requestedBy: withdrawal.requestedBy,
    createdAt: withdrawal.createdAt.toISOString(),
  };
}