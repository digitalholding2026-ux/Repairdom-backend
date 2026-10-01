import { Injectable, Logger } from '@nestjs/common';
import type { DemandeStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiAdminService } from './ai-admin.service.js';

/* IA-11 — Agent IA du back-office (ADMIN uniquement, LECTURE SEULE).
 *
 * L'agent n'est PAS une deuxième base de données : interface
 * conversationnelle au-dessus des données réelles, en 3 temps :
 *   1. planificateur (LLM, JSON strict) : question → {tool, args} ;
 *   2. exécuteur (code, whitelist fermée) : AUCUN SQL libre, aucune écriture ;
 *   3. synthèse (LLM, JSON strict) : chiffres réels → réponse factuelle.
 *
 * Garanties :
 * - le modèle ne voit que des agrégats/listes bornées, jamais de PII
 *   inutile (pas de noms clients, téléphone, email, adresse, GPS, secrets) ;
 * - statistique = tool obligatoire, sinon « donnée indisponible » ;
 * - demande d'action (suspendre, supprimer, modifier, payer…) → refus
 *   déterministe + renvoi vers les outils admin (jamais de mutation) ;
 * - IA désactivée/indisponible → message propre, JAMAIS de chiffre inventé ;
 * - aucune persistance (historique = session frontend, bornée par requête) ;
 * - périodes calculées serveur (fuseau métier Africa/Douala documenté),
 *   jamais l'heure du navigateur.
 *
 * Relio fournit les chiffres. L'IA synthétise. L'humain décide. */

export const AI_AGENT_PROMPT_VERSION = 1;
/* IA-11.2 — plafonds de sortie via `AiConfig` (`agentPlanMaxTokens` = 800,
 * `agentSynthMaxTokens` = 1500) : l'ancienne constante dispersée est
 * supprimée au profit de la configuration centralisée. */
/** Fuseau métier (Afrique/Centre, UTC+1 fixe sans DST — bornes « jour »). */
export const AI_AGENT_TIMEZONE = 'Africa/Douala';
export const AI_AGENT_TIMEZONE_OFFSET_MS = 3_600_000;
export const AI_AGENT_MAX_HISTORY = 10;
export const AI_AGENT_MAX_MESSAGE_CHARS = 1000;
export const AI_AGENT_MAX_REPLY_CHARS = 4000;

export const AI_AGENT_PERIODS = ['today', 'yesterday', 'last7d', 'last30d'] as const;
export type AiAgentPeriod = (typeof AI_AGENT_PERIODS)[number];

const ACTIVE_MISSION_STATUSES: DemandeStatus[] = ['ACCEPTED', 'SCHEDULED', 'IN_PROGRESS'];
const CLOSED_MISSION_STATUSES: DemandeStatus[] = ['COMPLETED', 'CONFIRMED'];

/* Demande d'action : refus déterministe AVANT tout appel LLM (heuristic
 * premier rempart, consigne de synthèse en second). Formes impératives et
 * infinitives ; les participes de contexte statistique (« annulées »,
 * « supprimés ») ne déclenchent pas. */
const ACTION_PATTERNS =
  /\b(suspends?|suspendre|suspension|bannis?s?|bannir|supprime[rz]?|suppression|désactive[rz]?|bloque[rz]?|blocage|modifie[rz]?|modification|change[rz]? le|pa(?:ie|yer|iements?)|rembourse[rz]?|remboursement|envo(?:ie[sz]?|yer)|créé?[rz]?|créer|ajoute[rz]?|retire[rz]?|annule[rz]?(?!ées|és)|clôture|rends?|valide[rz]?|rejette[rz]?|désinscris?)\b/i;

export const AI_AGENT_ACTION_REFUSAL =
  'Je peux analyser la situation, mais je ne peux pas effectuer cette action : ' +
  'utilisez les outils administratifs classiques (missions, utilisateurs, reviews). ' +
  'Précisez quelle situation examiner et je fournirai les chiffres.';

export const AI_AGENT_DISABLED_MESSAGE =
  "Je n'ai pas pu interroger le service IA actuellement (désactivé ou non configuré). " +
  'Les données du back-office restent accessibles normalement (Surveillance IA, missions, finances).';

export const AI_AGENT_FAILURE_MESSAGE =
  "Je n'ai pas pu interroger le service IA actuellement. " +
  'Les données du back-office restent accessibles normalement — aucun chiffre ne peut être fourni sans vérification.';

export const AI_AGENT_MISUNDERSTOOD_MESSAGE =
  "Je n'ai pas compris précisément la question. Reformulez (ex. « techniciens disponibles », " +
  '« activité aujourd’hui », « surveillance IA », « missions en cours »).';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/* IA-11 diagnostic : qualifie un échec d'appel gateway en étape exacte,
 * SANS contenu (messages d'erreur du gateway = libellés génériques sûrs).
 * - transport : corps HTTP illisible / réseau / timeout / 4xx-5xx ;
 * - extraction : HTTP 200 sans contenu textuel exploitable ;
 * - json_parse : HTTP 200 textuel mais JSON irrécupérable. */
function describeAgentFailure(error: unknown): {
  parseStage: 'transport' | 'extraction' | 'json_parse' | 'unknown';
  failureReason: string;
  httpStatus: number | null;
  finishReason: string | null;
  abortReason: string | null;
} {
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : '';
  const code = typeof record?.code === 'string' ? record.code : null;
  const httpStatus =
    typeof record?.httpStatus === 'number' && Number.isFinite(record.httpStatus)
      ? (record.httpStatus as number)
      : message === 'Réponse IA illisible.' ||
          message === 'Réponse IA inexploitable.' ||
          message === 'Réponse IA non-JSON.'
        ? 200
        : null;
  /* IA-11.2 — motif d'arrêt propagé par le gateway (`length` = troncature
   * par `max_tokens`, libellé sûr et borné, jamais du contenu).
   * IA-11.3 — classification transport + cause d'avort propagées de même
   * (chaînes fermées, jamais du contenu). */
  const finishReason = typeof record?.finishReason === 'string' ? (record.finishReason as string) : null;
  const transport = typeof record?.transportReason === 'string' ? (record.transportReason as string) : null;
  const abortReason = typeof record?.abortReason === 'string' ? (record.abortReason as string) : null;
  const base = { httpStatus, finishReason, abortReason };
  // Classification gateway (IA-11.3) prioritaire ; repli sur les libellés
  // pour les gateways mockés des tests historiques.
  if (transport === 'request_timeout') {
    return { parseStage: 'transport', failureReason: 'request_timeout', ...base };
  }
  if (transport === 'request_network_error') {
    return { parseStage: 'transport', failureReason: 'request_network_error', ...base };
  }
  if (transport === 'body_read_error') {
    return { parseStage: 'transport', failureReason: 'body_read_error', ...base };
  }
  if (transport === 'invalid_openrouter_payload') {
    return { parseStage: 'extraction', failureReason: 'invalid_openrouter_payload', ...base };
  }
  if (transport === 'upstream_rate_limited') {
    return { parseStage: 'transport', failureReason: 'upstream_rate_limited', ...base };
  }
  if (transport === 'upstream_server_error') {
    return { parseStage: 'transport', failureReason: 'upstream_server_error', ...base };
  }
  if (transport === 'provider_refused') {
    return { parseStage: 'transport', failureReason: 'provider_refused', ...base };
  }
  if (transport === 'disabled') {
    return { parseStage: 'transport', failureReason: 'disabled', ...base };
  }
  if (message === 'Réponse IA illisible.') {
    return { parseStage: 'transport', failureReason: 'unreadable_body', ...base };
  }
  if (message === 'Réponse IA inexploitable.') {
    return { parseStage: 'extraction', failureReason: 'empty_or_missing_content', ...base };
  }
  if (message === 'Réponse IA non-JSON.') {
    return { parseStage: 'json_parse', failureReason: 'non_json_content', ...base };
  }
  if (code === 'AI_UPSTREAM' || /temporairement indisponible/i.test(message)) {
    const reason = /timeout/i.test(message) ? 'timeout' : 'upstream_unavailable';
    return { parseStage: 'transport', failureReason: reason, ...base };
  }
  if (code === 'AI_TERMINAL' || /refusée par le fournisseur/i.test(message)) {
    return { parseStage: 'transport', failureReason: 'provider_refused', ...base };
  }
  if (code === 'AI_DISABLED' || /désactivé|non configuré/i.test(message)) {
    return { parseStage: 'transport', failureReason: 'disabled', ...base };
  }
  return { parseStage: 'unknown', failureReason: 'unexpected_error', ...base };
}

/** Début de journée métier (Douala) décalée de `offsetDays` (0 = aujourd'hui). */
export function doualaDayStart(now: Date, offsetDays = 0): Date {
  const shifted = new Date(now.getTime() + AI_AGENT_TIMEZONE_OFFSET_MS);
  const midnightUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnightUtc - AI_AGENT_TIMEZONE_OFFSET_MS + offsetDays * 86_400_000);
}

/** Fenêtre [from, to) d'une période métier. */
export function periodBounds(period: AiAgentPeriod, now: Date): { from: Date | null; to: Date | null } {
  const today = doualaDayStart(now, 0);
  const tomorrow = doualaDayStart(now, 1);
  switch (period) {
    case 'today':
      return { from: today, to: tomorrow };
    case 'yesterday':
      return { from: doualaDayStart(now, -1), to: today };
    case 'last7d':
      return { from: doualaDayStart(now, -6), to: tomorrow };
    case 'last30d':
      return { from: doualaDayStart(now, -29), to: tomorrow };
    default:
      return { from: null, to: null };
  }
}

export interface AiAgentHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiAgentToolCall {
  tool: string;
  ok: boolean;
}

export interface AiAgentChatResult {
  reply: string;
  toolCalls: AiAgentToolCall[];
  model: string | null;
}

const AGENT_TOOLS = [
  'get_overview',
  'get_technicians',
  'get_demandes',
  'get_missions',
  'get_users',
  'get_reviews',
  'get_recent_demandes',
] as const;

type AgentTool = (typeof AGENT_TOOLS)[number];

@Injectable()
export class AiAdminAgentService {
  private readonly logger = new Logger(AiAdminAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfig,
    private readonly gateway: AiGatewayService,
    private readonly overview: AiAdminService,
  ) {}

  /** Disponibilité de l'agent (interrupteur + clé + URL). */
  status() {
    const available = this.aiConfig.isConfigured();
    return {
      available,
      model: available ? this.aiConfig.model : null,
      promptVersion: AI_AGENT_PROMPT_VERSION,
      reason: available ? null : (this.aiConfig.refusalReason() ?? 'non configuré'),
    };
  }

  /** Question admin → réponse factuelle (jamais d'exception métier : tout
   *  échec produit un message propre, jamais un chiffre inventé). */
  async chat(message: string, history: AiAgentHistoryItem[] = [], now: Date = new Date()): Promise<AiAgentChatResult> {
    const question = truncate(message, AI_AGENT_MAX_MESSAGE_CHARS);
    if (!question) {
      return { reply: AI_AGENT_MISUNDERSTOOD_MESSAGE, toolCalls: [], model: null };
    }
    // Garde déterministe : demande d'action → refus sans appel LLM.
    if (ACTION_PATTERNS.test(question)) {
      this.logger.log(`Agent IA : demande d'action refusée (question de ${question.length} car.).`);
      return { reply: AI_AGENT_ACTION_REFUSAL, toolCalls: [], model: null };
    }
    if (!this.aiConfig.isConfigured()) {
      this.logger.log(`Agent IA indisponible (${this.aiConfig.refusalReason() ?? 'non configuré'}).`);
      return { reply: AI_AGENT_DISABLED_MESSAGE, toolCalls: [], model: null };
    }
    const cleanHistory = this.normalizeHistory(history);
    try {
      const plan = await this.plan(question, cleanHistory);
      if (!plan) return { reply: AI_AGENT_MISUNDERSTOOD_MESSAGE, toolCalls: [], model: null };
      let toolData: unknown = null;
      const toolCalls: AiAgentToolCall[] = [];
      if (plan.tool) {
        toolData = await this.executeTool(plan.tool, plan.args, now);
        toolCalls.push({ tool: plan.tool, ok: toolData !== null });
      }
      const reply = await this.synthesize(question, plan.tool, toolData, now);
      if (!reply) return { reply: AI_AGENT_FAILURE_MESSAGE, toolCalls, model: null };
      return reply;
    } catch (error) {
      // Timeout / 429 / 5xx / invalide : message propre, chiffres jamais inventés.
      this.logger.warn(
        `Agent IA indisponible : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
      );
      return { reply: AI_AGENT_FAILURE_MESSAGE, toolCalls: [], model: null };
    }
  }

  private normalizeHistory(history: AiAgentHistoryItem[]): AiAgentHistoryItem[] {
    return history
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
      .slice(-AI_AGENT_MAX_HISTORY)
      .map((item) => ({ role: item.role, content: truncate(String(item.content ?? ''), AI_AGENT_MAX_MESSAGE_CHARS) }))
      .filter((item) => item.content.length > 0);
  }

  /* Planificateur : question → {tool|null, args} (JSON strict, whitelist
   * validée côté backend — le modèle ne choisit jamais de SQL).
   * Logs : `Agent IA plan ok|failed …` avec étape exacte
   * (transport/extraction/json_parse/schema_validation), sans JAMAIS
   * journaliser question, historique, données outils ou contenu IA. */
  private async plan(
    question: string,
    history: AiAgentHistoryItem[],
  ): Promise<{ tool: AgentTool | null; args: Record<string, unknown> } | null> {
    const historyBlock =
      history.length > 0
        ? `Contexte récent :\n${history.map((h) => `${h.role === 'user' ? 'Admin' : 'Agent'} : ${h.content}`).join('\n')}\n`
        : '';
    const startedAt = Date.now();
    let completion: { result: unknown };
    try {
      completion = await this.gateway.completeJson<unknown>({
        caller: 'AiAdminAgentPlan',
        messages: [
          { role: 'system', content: this.plannerPrompt() },
          { role: 'user', content: `${historyBlock}Question : ${question}` },
        ],
        /* IA-11.2 — plafond centralisé (défaut 800) : 300 tokens
         * provoquait `finish_reason=length` à contenu vide. */
        maxTokens: this.aiConfig.agentPlanMaxTokens,
        timeoutMs: this.aiConfig.chatTimeoutMs,
        correlationId: `ai-agent-plan-${Date.now()}`,
      });
    } catch (error) {
      const failure = describeAgentFailure(error);
      this.logger.warn(
        `Agent IA plan failed parseStage=${failure.parseStage} failureReason=${failure.failureReason} ` +
          `durationMs=${Date.now() - startedAt} httpStatus=${failure.httpStatus ?? 'unknown'} ` +
          `finishReason=${failure.finishReason ?? 'unknown'} abortReason=${failure.abortReason ?? 'unknown'}`,
      );
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    const record = asRecord(completion.result);
    if (!record) {
      this.logger.warn(
        `Agent IA plan failed parseStage=schema_validation failureReason=non_object ` +
          `durationMs=${durationMs} httpStatus=200 ` +
          `resultType=${Array.isArray(completion.result) ? 'array' : typeof completion.result}`,
      );
      return null;
    }
    if (record.tool === null || record.tool === undefined || record.tool === 'none') {
      this.logger.log(`Agent IA plan ok tool=none durationMs=${durationMs}`);
      return { tool: null, args: {} };
    }
    if (typeof record.tool !== 'string' || !(AGENT_TOOLS as readonly string[]).includes(record.tool)) {
      this.logger.warn(
        `Agent IA plan failed parseStage=schema_validation failureReason=unknown_tool ` +
          `durationMs=${durationMs} httpStatus=200 toolPresent=${typeof record.tool === 'string'} ` +
          `toolValueLength=${typeof record.tool === 'string' ? record.tool.length : 0}`,
      );
      return null;
    }
    this.logger.log(`Agent IA plan ok tool=${record.tool} durationMs=${durationMs}`);
    return { tool: record.tool as AgentTool, args: asRecord(record.args) ?? {} };
  }

  /* IA-11.2 — prompt compact (moins de tokens d'entrée, sortie < 200
   * caractères) : contenu fonctionnel inchangé (7 outils, périodes,
   * cas null, interdiction d'action). */
  private plannerPrompt(): string {
    return [
      'Planificateur Agent IA back-office Relio (admin, lecture seule).',
      'Réponse : UNIQUEMENT un JSON de moins de 200 caractères, sans texte ni justification : {"tool":"get_technicians","args":{"period":"today"}}.',
      'Outils → args minimaux : get_overview (compteurs IA-4→IA-8, {}), get_technicians (dispo/missions/KYC, {}), get_demandes (statuts, {"period"}), get_missions (actives/terminées, {"period"}), get_users (inscriptions, {"period"}), get_reviews (avis note basse, jamais "plaintes", {"limit":1..10}), get_recent_demandes (dernières, {"limit":1..10}).',
      'Période : today (défaut), yesterday, last7d, last30d. Capacité/présentation ou incompréhensible → {"tool":null,"args":{}}.',
      'JAMAIS d’action (suspendre, modifier, payer…) : pas ton rôle.',
    ].join('\n');
  }

  /* Exécuteur : whitelist fermée de requêtes Prisma en lecture seule
   * (comptes/agrégats + listes bornées, colonnes minimales, index existants).
   * Argument inconnu → ignoré (valeur sûre). Jamais d'écriture. */
  private async executeTool(tool: AgentTool, args: Record<string, unknown>, now: Date): Promise<unknown> {
    switch (tool) {
      case 'get_overview':
        return this.overview.getOverview(now);
      case 'get_technicians':
        return this.toolTechnicians();
      case 'get_demandes':
        return this.toolDemandes(this.validPeriod(args.period));
      case 'get_missions':
        return this.toolMissions(this.validPeriod(args.period), now);
      case 'get_users':
        return this.toolUsers(this.validPeriod(args.period));
      case 'get_reviews':
        return this.toolReviews(this.validLimit(args.limit));
      case 'get_recent_demandes':
        return this.toolRecentDemandes(this.validLimit(args.limit));
      default:
        return null;
    }
  }

  private validPeriod(period: unknown): AiAgentPeriod {
    return typeof period === 'string' && (AI_AGENT_PERIODS as readonly string[]).includes(period)
      ? (period as AiAgentPeriod)
      : 'today';
  }

  private validLimit(limit: unknown): number {
    const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 5;
    return Math.min(Math.max(value, 1), 10);
  }

  private async toolTechnicians() {
    const [total, available, kycGroups, activeMissions, enRouteMissions, arrivedMissions] = await Promise.all([
      this.prisma.technicianProfile.count(),
      this.prisma.technicianProfile.count({ where: { isAvailable: true } }),
      this.prisma.technicianProfile.groupBy({ by: ['kycStatus'], _count: { _all: true } }),
      this.prisma.demande.findMany({
        where: { status: { in: ACTIVE_MISSION_STATUSES }, technicianId: { not: null } },
        select: { technicianId: true, status: true, technicianEnRouteAt: true, technicianArrivedAt: true },
      }),
      this.prisma.demande.count({
        where: { technicianEnRouteAt: { not: null }, technicianArrivedAt: null },
      }),
      this.prisma.demande.count({
        where: { technicianArrivedAt: { not: null } },
      }),
    ]);
    const inMission = new Set(activeMissions.map((m) => m.technicianId).filter((id): id is string => !!id)).size;
    const kycByStatus: Record<string, number> = {};
    for (const group of kycGroups) {
      kycByStatus[group.kycStatus] = group._count._all;
    }
    return {
      total,
      available,
      unavailable: total - available,
      inMission,
      enRouteMissions,
      arrivedMissions,
      kycByStatus,
    };
  }

  private async toolDemandes(period: AiAgentPeriod) {
    // Fenêtre glissante via bornes métier (now = appelant, testable).
    const now = new Date();
    const { from, to } = periodBounds(period, now);
    const createdWhere =
      from && to ? { createdAt: { gte: from, lt: to } } : {};
    const [created, byStatusGroups, autreTotal, autreClassified] = await Promise.all([
      this.prisma.demande.count({ where: createdWhere }),
      this.prisma.demande.groupBy({
        by: ['status'],
        _count: { _all: true },
        ...(from && to ? { where: { createdAt: { gte: from, lt: to } } } : {}),
      }),
      this.prisma.demande.count({ where: { ...createdWhere, category: 'autre' } }),
      this.prisma.demandeClassification.count({
        where: { classification: 'CLASSIFIED', ...(from && to ? { createdAt: { gte: from, lt: to } } : {}) },
      }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const group of byStatusGroups) {
      byStatus[group.status] = group._count._all;
    }
    return { period, created, byStatus, autre: { total: autreTotal, classified: autreClassified } };
  }

  private async toolMissions(period: AiAgentPeriod, now: Date) {
    const { from, to } = periodBounds(period, now);
    const inPeriod = from && to ? { gte: from, lt: to } : undefined;
    const [active, completed, pendingValidation, canceled] = await Promise.all([
      this.prisma.demande.count({ where: { status: { in: ACTIVE_MISSION_STATUSES } } }),
      this.prisma.demande.count({
        where: { status: { in: CLOSED_MISSION_STATUSES }, ...(inPeriod ? { updatedAt: inPeriod } : {}) },
      }),
      // COMPLETED non encore CONFIRMED = en attente de validation client.
      this.prisma.demande.count({ where: { status: 'COMPLETED' } }),
      this.prisma.demande.count({
        where: { status: 'CANCELED', ...(inPeriod ? { updatedAt: inPeriod } : {}) },
      }),
    ]);
    return { period, active, completed, pendingValidation, canceled };
  }

  private async toolUsers(period: AiAgentPeriod) {
    const now = new Date();
    const { from, to } = periodBounds(period, now);
    const where = from && to ? { createdAt: { gte: from, lt: to } } : {};
    const [total, byRoleGroups] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.groupBy({ by: ['role'], _count: { _all: true }, where }),
    ]);
    const byRole: Record<string, number> = {};
    for (const group of byRoleGroups) {
      byRole[group.role] = group._count._all;
    }
    return { period, total, byRole };
  }

  /* Avis récents à note basse : présentés comme des AVIS (jamais des
   * « plaintes »), sans noms d'auteurs, commentaire tronqué. */
  private async toolReviews(limit: number) {
    const rows = await this.prisma.review.findMany({
      where: { rating: { lte: 2 } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        demande: { select: { id: true, reference: true } },
      },
    });
    return {
      count: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        rating: row.rating,
        comment: row.comment ? truncate(row.comment, 200) : null,
        demandeReference: row.demande?.reference ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  private async toolRecentDemandes(limit: number) {
    const rows = await this.prisma.demande.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, reference: true, category: true, status: true, city: true, createdAt: true },
    });
    return {
      count: rows.length,
      items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  }

  /* Synthèse : chiffres réels → réponse factuelle (JSON strict). Niveaux
   * de langage imposés : observé / calculé / indisponible. Refus d'action
   * en second rempart (le premier est déterministe, avant LLM). */
  private async synthesize(
    question: string,
    tool: AgentTool | null,
    toolData: unknown,
    now: Date,
  ): Promise<AiAgentChatResult | null> {
    const dataBlock =
      tool && toolData !== null
        ? `Données vérifiées du tool ${tool} (seule source de chiffres) :\n${JSON.stringify(toolData).slice(0, 4000)}`
        : 'Aucune donnée chiffrée disponible pour cette question.';
    const startedAt = Date.now();
    let completion: { result: unknown; model: string };
    try {
      completion = await this.gateway.completeJson<unknown>({
        caller: 'AiAdminAgentSynth',
        messages: [
          { role: 'system', content: this.synthesisPrompt(now) },
          { role: 'user', content: `Question : ${question}\n${dataBlock}` },
        ],
        /* IA-11.2 — plafond centralisé (défaut 1500) : 800 tokens
         * coupaient le JSON à ~680 car. (`finish_reason=length`). */
        maxTokens: this.aiConfig.agentSynthMaxTokens,
        timeoutMs: this.aiConfig.chatTimeoutMs,
        correlationId: `ai-agent-synth-${Date.now()}`,
      });
    } catch (error) {
      const failure = describeAgentFailure(error);
      this.logger.warn(
        `Agent IA synth failed parseStage=${failure.parseStage} failureReason=${failure.failureReason} ` +
          `durationMs=${Date.now() - startedAt} httpStatus=${failure.httpStatus ?? 'unknown'} ` +
          `finishReason=${failure.finishReason ?? 'unknown'} abortReason=${failure.abortReason ?? 'unknown'}`,
      );
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    const record = asRecord(completion.result);
    const reply = typeof record?.reply === 'string' ? record.reply.trim() : null;
    if (!reply) {
      this.logger.warn(
        `Agent IA synth failed parseStage=schema_validation failureReason=missing_reply ` +
          `durationMs=${durationMs} httpStatus=200 ` +
          `resultType=${Array.isArray(completion.result) ? 'array' : typeof completion.result} ` +
          `replyPresent=${typeof record?.reply === 'string'}`,
      );
      return null;
    }
    this.logger.log(`Agent IA synth ok replyLength=${reply.length} durationMs=${durationMs}`);
    return {
      reply: truncate(reply, AI_AGENT_MAX_REPLY_CHARS),
      toolCalls: tool ? [{ tool, ok: toolData !== null }] : [],
      model: completion.model,
    };
  }

  /* IA-11.2 — prompt compact (sortie : une à deux phrases dans
   * `{"reply": …}`, jamais de recalcul ni de répétition des données).
   * IA-11.3 — contrat JSON durci en tête (le modèle sortait parfois de la
   * prose brute malgré `finish_reason=stop`) : JSON seul, sans markdown,
   * sans prose hors JSON, sans explication. Règles métier et de sécurité
   * intégralement conservées ; AUCUN fallback sémantique (la prose reste
   * refusée en `non_json_content`, jamais convertie en `{"reply":…}`). */
  private synthesisPrompt(now: Date): string {
    return [
      'Tu réponds UNIQUEMENT en JSON strict et valide : {"reply":"..."}. Aucun markdown, aucune prose hors JSON, aucune explication.',
      'Agent IA back-office Relio (administrateurs exclusivement). "reply" = une à deux phrases, en français, à partir des données vérifiées ci-dessus uniquement. Ne répète pas les données brutes, ne recalcule rien.',
      'Règles : sans données → "pas de donnée structurée" (jamais d’invention) ; observé/calcul/interprétation distingués, estimation interdite ; signaux IA-7/IA-8 = revue humaine, ni accusations ni scores, pas de classement ; avis note basse = des avis, jamais des "plaintes" ; demande d’action → refus + renvoi outils admin.',
      `Contexte serveur : ${now.toISOString()} (fuseau ${AI_AGENT_TIMEZONE}).`,
    ].join('\n');
  }
}
