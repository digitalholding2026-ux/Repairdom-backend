import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  FinancialTransactionDirection,
  FinancialTransactionMode,
  FinancialTransactionType,
} from '../generated/prisma/enums.js';
import {
  CLIENT_PLATFORM_FEE,
  FINANCIAL_CURRENCY,
  TECHNICIAN_PLATFORM_FEE,
  TOTAL_PLATFORM_FEES,
} from './financial-fees.js';

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

  /** Découpe un quote en composantes réparation / transport.
   *  CATALOG : travelAmount (snapshot du travelFee catalogue), sinon
   *  initialTravelFee des anciens tarifs, sinon 0.
   *  MANUAL  : travelAmount saisi par le technicien, sinon 0. Jamais inventé :
   *  le transport est extrait du montant total, le reste est la réparation. */
  splitQuote(input: QuoteSnapshot): { repairAmount: number; travelAmount: number } {
    const travelAmount = input.travelAmount ?? input.initialTravelFee ?? 0;
    const repairAmount = input.amount - travelAmount;
    if (repairAmount < 0) {
      throw new BadRequestException(
        'Le montant du transport ne peut pas dépasser le montant total du tarif.',
      );
    }
    return { repairAmount, travelAmount };
  }

  /** Acceptation d'un quote — débit client REPAIRDOM (atomique avec
   *  l'acceptation, dans la même transaction) :
   *    CLIENT_MISSION_DEBIT : réparation + transport (montant total du quote)
   *    CLIENT_FEE            : 100 XAF
   *  Règle : le client paie au moment où il valide le tarif. Le débit utilise
   *  des références serveur idempotentes (quote + demande + mode). */
  async debitClientAtAcceptance(
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

    await this.record(tx, {
      userId: args.clientId,
      demandeId: args.demandeId,
      type: 'CLIENT_MISSION_DEBIT',
      direction: 'DEBIT',
      amount: args.quote.amount,
      reference: `client-mission-debit:${args.demandeId}:${args.quote.id}:${mode}`,
      createdById: args.actorUserId,
      metadata: {
        repair: repairAmount,
        travel: travelAmount,
        currency: FINANCIAL_CURRENCY,
      },
    });

    await this.record(tx, {
      userId: args.clientId,
      demandeId: args.demandeId,
      type: 'CLIENT_FEE',
      direction: 'DEBIT',
      amount: CLIENT_PLATFORM_FEE,
      reference: `client-fee:${args.demandeId}:${args.quote.id}:${mode}`,
      createdById: args.actorUserId,
      metadata: { fee: CLIENT_PLATFORM_FEE, currency: FINANCIAL_CURRENCY },
    });
  }

  /** Confirmation de la mission — rémunération du technicien (atomique avec
   *  la transition CONFIRMED, dans la même transaction) :
   *    TECHNICIAN_REPAIR_REVENUE CREDIT = réparation
   *    TECHNICIAN_TRAVEL_REVENUE CREDIT = transport (100 % au technicien)
   *    TECHNICIAN_FEE            DEBIT  = 150 XAF
   *  Rien n'est crédité à COMPLETED. Missions legacy sans quote ACCEPTED :
   *  aucune écriture (pas de transaction rétroactive). */
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

    // Une composante nulle (transport absent, ou réparation nulle quand le
    // tarif ne couvre que le transport) ne donne pas lieu à une écriture.
    if (repairAmount > 0) {
      await this.record(tx, {
        userId: args.technicianId,
        demandeId: args.demandeId,
        type: 'TECHNICIAN_REPAIR_REVENUE',
        direction: 'CREDIT',
        amount: repairAmount,
        reference: `technician-repair:${args.demandeId}:${quote.id}:${mode}`,
        createdById: args.createdById,
        metadata: { repair: repairAmount, travel: travelAmount, currency: FINANCIAL_CURRENCY },
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
        metadata: { repair: repairAmount, travel: travelAmount, currency: FINANCIAL_CURRENCY },
      });
    }

    await this.record(tx, {
      userId: args.technicianId,
      demandeId: args.demandeId,
      type: 'TECHNICIAN_FEE',
      direction: 'DEBIT',
      amount: TECHNICIAN_PLATFORM_FEE,
      reference: `technician-fee:${args.demandeId}:${quote.id}:${mode}`,
      createdById: args.createdById,
      metadata: { fee: TECHNICIAN_PLATFORM_FEE, currency: FINANCIAL_CURRENCY },
    });
  }

  /** Annulation d'une mission déjà débitée — contrepassation atomique (même
   *  transaction que le passage à CANCELED) :
   *    REVERSAL CREDIT = montant débité (réparation + transport)
   *    REVERSAL CREDIT = frais client 100
   *  Les écritures originales ne sont JAMAIS modifiées ni supprimées ;
   *  chaque contrepassation est liée par reversalOfId et idempotente. */
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

  /** Réconciliation RepairDom par mission financièrement réglée :
   *  CLIENT_FEE + TECHNICIAN_FEE = 250 XAF. Le transport et la réparation ne
   *  sont jamais comptés comme revenu RepairDom ; Pricing.serviceFee non plus. */
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
    const repairDomRevenue = clientFee + technicianFee;

    return {
      demandeId,
      financials: {
        clientMissionDebit: sum('CLIENT_MISSION_DEBIT', 'DEBIT'),
        clientFee,
        technicianRepair: sum('TECHNICIAN_REPAIR_REVENUE', 'CREDIT'),
        technicianTravel: sum('TECHNICIAN_TRAVEL_REVENUE', 'CREDIT'),
        technicianFee,
        repairDomRevenue,
        expectedRepairDomRevenue: TOTAL_PLATFORM_FEES,
        reconciled: repairDomRevenue === TOTAL_PLATFORM_FEES,
      },
      entries,
    };
  }

  /** Vérifie la réconciliation globale 100 + 150 = 250 sur toutes les
   *  missions du mode : aucune mission ne doit présenter d'écart. */
  async reconcileRepairDomFees(mode: FinancialTransactionMode) {
    this.ensureModeAllowed(mode);
    const demandes = await this.prisma.financialTransaction.findMany({
      where: { mode, type: { in: ['CLIENT_FEE', 'TECHNICIAN_FEE'] } },
      select: { demandeId: true, type: true, direction: true, amount: true, status: true },
    });

    const byMission = new Map<
      string,
      { clientFee: number; technicianFee: number }
    >();
    for (const t of demandes) {
      if (!t.demandeId || t.status !== 'VALIDATED') continue;
      const bucket = byMission.get(t.demandeId) ?? { clientFee: 0, technicianFee: 0 };
      if (t.type === 'CLIENT_FEE' && t.direction === 'DEBIT') bucket.clientFee += t.amount;
      if (t.type === 'TECHNICIAN_FEE' && t.direction === 'DEBIT') bucket.technicianFee += t.amount;
      byMission.set(t.demandeId, bucket);
    }

    const missions = [...byMission.entries()].map(([demandeId, fees]) => ({
      demandeId,
      ...fees,
      total: fees.clientFee + fees.technicianFee,
      reconciled: fees.clientFee + fees.technicianFee === TOTAL_PLATFORM_FEES,
    }));

    const mismatched = missions.filter((m) => !m.reconciled);
    return { totalMissions: missions.length, mismatches: mismatched, expectedPerMission: TOTAL_PLATFORM_FEES };
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
        mission.reconciled =
          mission.repairDomRevenue === TOTAL_PLATFORM_FEES &&
          mission.clientFee > 0 &&
          mission.technicianFee > 0;
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
        expectedPerMission: TOTAL_PLATFORM_FEES,
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
        expectedRepairDomRevenue: TOTAL_PLATFORM_FEES,
        reconciled: repairDomRevenue === TOTAL_PLATFORM_FEES,
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
   *  jamais créé automatiquement à la connexion. Réservé ADMIN. */
  async createTestCredit(actorUserId: string, targetUserId: string, amount: number) {
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
}