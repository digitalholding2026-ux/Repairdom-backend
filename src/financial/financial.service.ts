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