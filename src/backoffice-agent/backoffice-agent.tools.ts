import { PrismaService } from '../prisma/prisma.service.js';

/* Outils de lecture de l'Agent Backoffice — GARANTIE TECHNIQUE READ-ONLY.
 * Règles :
 * - uniquement des requêtes `findMany / findUnique / findFirst / count` ;
 * - AUCUN `create / update / delete / upsert / executeRaw / queryRaw`
 *   (vérifié par test statique : `backoffice-agent.spec.ts`) ;
 * - `select` explicites : jamais les champs sensibles de User
 *   (`passwordHash`, `passwordResetToken*`, `tokenVersion`,
 *   `emailVerificationToken*`) ni les chemins de stockage privés
 *   (`audioStoragePath` → exposé comme `hasAudio: boolean`) ;
 * - résultats plafonnés (`take` + troncature côté agent) ;
 * - filtres enum validés contre des listes fermées (valeur inconnue =
 *   erreur propre, jamais d'exception Prisma vers le modèle).
 * L'agent ne voit QUE ces fonctions : aucun accès Prisma direct, aucun SQL. */

export const BACKOFFICE_AGENT_MAX_ROWS = 20;

const DEMANDE_STATUSES = [
  'SUBMITTED',
  'PENDING',
  'ACCEPTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CONFIRMED',
  'CANCELED',
] as const;

const USER_ROLES = ['CLIENT', 'TECHNICIAN', 'ADMIN'] as const;

const DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'] as const;

const QUOTE_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;

function assertEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} invalide (attendu : ${allowed.join(' | ')}).`);
  }
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return BACKOFFICE_AGENT_MAX_ROWS;
  return Math.min(Math.floor(n), BACKOFFICE_AGENT_MAX_ROWS);
}

function sinceDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Date invalide (format ISO attendu).');
  return date;
}

const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  city: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

export interface AgentToolContext {
  prisma: PrismaService;
}

export type AgentToolExecutor = (ctx: AgentToolContext, args: Record<string, unknown>) => Promise<unknown>;

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: AgentToolExecutor;
}

async function searchUsers(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length < 2) throw new Error('Recherche trop courte (2 caractères minimum).');
  assertEnum(args.role, USER_ROLES, 'role');
  const users = await ctx.prisma.user.findMany({
    where: {
      ...(typeof args.role === 'string' && args.role !== '' ? { role: args.role as never } : {}),
      OR: [
        { firstName: { contains: query, mode: 'insensitive' } },
        { lastName: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
        { phone: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: USER_SELECT,
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return users;
}

async function getUser(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.userId !== 'string' || args.userId.trim() === '') {
    throw new Error('userId requis.');
  }
  const user = await ctx.prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      ...USER_SELECT,
      _count: {
        select: {
          demandes: true,
          technicianDemandes: true,
          messages: true,
          diagnostics: true,
          quotes: true,
          notifications: true,
          financialTransactions: true,
        },
      },
    },
  });
  if (!user) throw new Error('Utilisateur introuvable.');
  return user;
}

const DEMANDE_LIST_SELECT = {
  id: true,
  reference: true,
  status: true,
  category: true,
  description: true,
  equipmentType: true,
  city: true,
  createdAt: true,
  client: { select: { id: true, firstName: true, lastName: true } },
  technician: { select: { id: true, firstName: true, lastName: true } },
} as const;

async function searchDemandes(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  assertEnum(args.status, DEMANDE_STATUSES, 'status');
  const since = sinceDate(args.since);
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const demandes = await ctx.prisma.demande.findMany({
    where: {
      ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status as never } : {}),
      ...(typeof args.userId === 'string' && args.userId !== ''
        ? { OR: [{ clientId: args.userId }, { technicianId: args.userId }] }
        : {}),
      ...(typeof args.reference === 'string' && args.reference !== ''
        ? { reference: args.reference.trim().toUpperCase() }
        : {}),
      ...(query !== '' ? { description: { contains: query, mode: 'insensitive' } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: DEMANDE_LIST_SELECT,
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return demandes;
}

async function getDemande(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.demandeId === 'string' ? args.demandeId.trim() : '';
  const reference = typeof args.reference === 'string' ? args.reference.trim().toUpperCase() : '';
  if (id === '' && reference === '') throw new Error('demandeId ou reference requis.');
  const demande = await ctx.prisma.demande.findUnique({
    where: id !== '' ? { id } : { reference },
    select: {
      ...DEMANDE_LIST_SELECT,
      neighborhood: true,
      finalAmount: true,
      diagnostics: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          mode: true,
          content: true,
          recommendation: true,
          proposedIntervention: true,
          justification: true,
          notes: true,
          audioStoragePath: true,
          createdAt: true,
          technician: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      quotes: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          source: true,
          description: true,
          createdAt: true,
          technician: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      dispute: {
        select: { id: true, status: true, category: true, description: true, createdAt: true },
      },
    },
  });
  if (!demande) throw new Error('Demande introuvable.');
  // Chemin de stockage privé jamais exposé : présence uniquement.
  const { diagnostics, ...rest } = demande;
  return {
    ...rest,
    diagnostics: diagnostics.map((diagnostic) => ({
      ...diagnostic,
      hasAudio: !!diagnostic.audioStoragePath,
      audioStoragePath: undefined,
    })),
  };
}

async function searchMessages(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  const raw = args.keywords;
  const keywords = (Array.isArray(raw) ? raw : [raw])
    .filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length >= 2)
    .map((keyword) => keyword.trim());
  if (keywords.length === 0) throw new Error('Au moins un mot-clé (2 caractères minimum) requis.');
  if (keywords.length > 5) throw new Error('5 mots-clés maximum.');
  const since = sinceDate(args.since);
  const messages = await ctx.prisma.message.findMany({
    where: {
      AND: keywords.map((keyword) => ({ content: { contains: keyword, mode: 'insensitive' } })),
      ...(typeof args.demandeId === 'string' && args.demandeId !== '' ? { demandeId: args.demandeId } : {}),
      ...(typeof args.senderId === 'string' && args.senderId !== '' ? { senderId: args.senderId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      id: true,
      content: true,
      createdAt: true,
      sender: { select: { id: true, firstName: true, lastName: true } },
      demande: { select: { id: true, reference: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return messages;
}

async function getConversation(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.demandeId !== 'string' || args.demandeId.trim() === '') {
    throw new Error('demandeId requis.');
  }
  const demande = await ctx.prisma.demande.findUnique({
    where: { id: args.demandeId },
    select: {
      id: true,
      reference: true,
      status: true,
      client: { select: { id: true, firstName: true, lastName: true } },
      technician: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!demande) throw new Error('Demande introuvable.');
  const messages = await ctx.prisma.message.findMany({
    where: { demandeId: args.demandeId },
    select: {
      id: true,
      content: true,
      createdAt: true,
      sender: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: clampLimit(args.limit),
  });
  return { demande, messages };
}

async function searchPayments(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  const since = sinceDate(args.since);
  const transactions = await ctx.prisma.financialTransaction.findMany({
    where: {
      ...(typeof args.userId === 'string' && args.userId !== '' ? { userId: args.userId } : {}),
      ...(typeof args.demandeId === 'string' && args.demandeId !== '' ? { demandeId: args.demandeId } : {}),
      ...(typeof args.reference === 'string' && args.reference !== ''
        ? { reference: args.reference.trim() }
        : {}),
      ...(typeof args.type === 'string' && args.type !== '' ? { type: args.type as never } : {}),
      ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status as never } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      id: true,
      reference: true,
      type: true,
      direction: true,
      amount: true,
      status: true,
      mode: true,
      createdAt: true,
      user: { select: { id: true, firstName: true, lastName: true } },
      demande: { select: { id: true, reference: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return transactions;
}

async function searchQuotes(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  assertEnum(args.status, QUOTE_STATUSES, 'status');
  if (
    (typeof args.demandeId !== 'string' || args.demandeId === '') &&
    (typeof args.technicianId !== 'string' || args.technicianId === '')
  ) {
    throw new Error('demandeId ou technicianId requis (pas de balayage global).');
  }
  const quotes = await ctx.prisma.quote.findMany({
    where: {
      ...(typeof args.demandeId === 'string' && args.demandeId !== '' ? { demandeId: args.demandeId } : {}),
      ...(typeof args.technicianId === 'string' && args.technicianId !== ''
        ? { technicianId: args.technicianId }
        : {}),
      ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status as never } : {}),
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      status: true,
      source: true,
      description: true,
      createdAt: true,
      demande: { select: { id: true, reference: true, status: true } },
      technician: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return quotes;
}

async function searchDisputes(ctx: AgentToolContext, args: Record<string, unknown>): Promise<unknown> {
  assertEnum(args.status, DISPUTE_STATUSES, 'status');
  const disputes = await ctx.prisma.demandeDispute.findMany({
    where: {
      ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status as never } : {}),
      ...(typeof args.demandeId === 'string' && args.demandeId !== '' ? { demandeId: args.demandeId } : {}),
    },
    select: {
      id: true,
      status: true,
      category: true,
      description: true,
      resolution: true,
      createdAt: true,
      demande: { select: { id: true, reference: true, status: true } },
      openedBy: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: clampLimit(args.limit),
  });
  return disputes;
}

function stringParam(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

export const BACKOFFICE_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'search_users',
    description: "Rechercher des utilisateurs Relio par nom, email ou téléphone. Ne retourne jamais de secrets.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texte recherché (2 caractères minimum).' },
        role: { type: 'string', description: 'Filtre : CLIENT, TECHNICIAN ou ADMIN.' },
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
      required: ['query'],
    },
    execute: searchUsers,
  },
  {
    name: 'get_user',
    description: "Consulter le profil public d'un utilisateur et le décompte de ses éléments Relio.",
    parameters: {
      type: 'object',
      properties: { userId: stringParam("Identifiant de l'utilisateur.") },
      required: ['userId'],
    },
    execute: getUser,
  },
  {
    name: 'search_demandes',
    description: 'Rechercher des demandes (missions) par statut, utilisateur, référence, texte ou période.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Statut : SUBMITTED, PENDING, ACCEPTED, SCHEDULED, IN_PROGRESS, COMPLETED, CONFIRMED, CANCELED.' },
        userId: stringParam('Filtrer par client ou technicien.'),
        reference: stringParam('Référence exacte, ex. RD-ABCDEF.'),
        query: stringParam('Texte dans la description.'),
        since: stringParam('Date ISO : éléments créés depuis.'),
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
    },
    execute: searchDemandes,
  },
  {
    name: 'get_demande',
    description: "Détail d'une demande : client, technicien, diagnostics, devis, litige éventuel.",
    parameters: {
      type: 'object',
      properties: {
        demandeId: stringParam("Identifiant de la demande."),
        reference: stringParam('Référence, ex. RD-ABCDEF (si demandeId inconnu).'),
      },
    },
    execute: getDemande,
  },
  {
    name: 'search_messages',
    description: 'Rechercher des messages de conversation contenant des mots-clés (tous doivent apparaître).',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Mots-clés (1 à 5, 2 caractères minimum chacun).' },
        demandeId: stringParam('Restreindre à une demande.'),
        senderId: stringParam("Restreindre à un expéditeur."),
        since: stringParam('Date ISO : messages depuis.'),
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
      required: ['keywords'],
    },
    execute: searchMessages,
  },
  {
    name: 'get_conversation',
    description: "Lire les messages d'une conversation (demande) dans l'ordre chronologique.",
    parameters: {
      type: 'object',
      properties: {
        demandeId: stringParam('Identifiant de la demande.'),
        limit: { type: 'number', description: 'Nombre max de messages (20 max).' },
      },
      required: ['demandeId'],
    },
    execute: getConversation,
  },
  {
    name: 'search_payments',
    description: 'Rechercher des écritures financières (ledger) par utilisateur, demande, référence, type ou statut.',
    parameters: {
      type: 'object',
      properties: {
        userId: stringParam('Filtrer par utilisateur.'),
        demandeId: stringParam('Filtrer par demande.'),
        reference: stringParam('Référence exacte.'),
        type: stringParam("Type d'écriture."),
        status: stringParam('Statut.'),
        since: stringParam('Date ISO : écritures depuis.'),
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
    },
    execute: searchPayments,
  },
  {
    name: 'search_quotes',
    description: 'Rechercher des devis (diagnostic + demande obligatoires : pas de balayage global).',
    parameters: {
      type: 'object',
      properties: {
        demandeId: stringParam('Filtrer par demande.'),
        technicianId: stringParam('Filtrer par technicien.'),
        status: stringParam('Statut : PENDING, ACCEPTED, REJECTED.'),
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
    },
    execute: searchQuotes,
  },
  {
    name: 'search_disputes',
    description: 'Rechercher des litiges par statut ou demande.',
    parameters: {
      type: 'object',
      properties: {
        status: stringParam('Statut : OPEN, UNDER_REVIEW, RESOLVED, REJECTED.'),
        demandeId: stringParam('Filtrer par demande.'),
        limit: { type: 'number', description: 'Nombre max de résultats (20 max).' },
      },
    },
    execute: searchDisputes,
  },
];
