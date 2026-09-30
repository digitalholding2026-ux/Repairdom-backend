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
export const AI_AGENT_MAX_TOKENS = 800;
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
   * validée côté backend — le modèle ne choisit jamais de SQL). */
  private async plan(
    question: string,
    history: AiAgentHistoryItem[],
  ): Promise<{ tool: AgentTool | null; args: Record<string, unknown> } | null> {
    const historyBlock =
      history.length > 0
        ? `Contexte récent :\n${history.map((h) => `${h.role === 'user' ? 'Admin' : 'Agent'} : ${h.content}`).join('\n')}\n`
        : '';
    const completion = await this.gateway.completeJson<unknown>({
      caller: 'AiAdminAgentPlan',
      messages: [
        { role: 'system', content: this.plannerPrompt() },
        { role: 'user', content: `${historyBlock}Question : ${question}` },
      ],
      maxTokens: 300,
      timeoutMs: this.aiConfig.chatTimeoutMs,
      correlationId: `ai-agent-plan-${Date.now()}`,
    });
    const record = asRecord(completion.result);
    if (!record) return null;
    if (record.tool === null || record.tool === undefined || record.tool === 'none') {
      return { tool: null, args: {} };
    }
    if (typeof record.tool !== 'string' || !(AGENT_TOOLS as readonly string[]).includes(record.tool)) {
      return null;
    }
    return { tool: record.tool as AgentTool, args: asRecord(record.args) ?? {} };
  }

  private plannerPrompt(): string {
    return [
      'Tu es le planificateur de l’Agent IA du back-office Relio (aide aux administrateurs).',
      'Tu réponds UNIQUEMENT en JSON strict, sans texte autour : {"tool": "get_technicians", "args": {"period": "today"}}.',
      'Outils disponibles (données réelles, lecture seule) :',
      '- get_overview : compteurs IA-4→IA-8 (classifications, mappings, contrôles, avertissements, flags) — args {}.',
      '- get_technicians : disponibilité, missions, déplacements, KYC — args {}.',
      '- get_demandes : demandes par statut + Autre/classifiées — args {"period": "today|yesterday|last7d|last30d"}.',
      '- get_missions : missions actives/terminées/en attente de validation — args {"period": ...}.',
      '- get_users : inscriptions par rôle — args {"period": ...}.',
      '- get_reviews : avis clients récents à note basse (jamais appelés "plaintes") — args {"limit": 1..10}.',
      '- get_recent_demandes : dernières demandes — args {"limit": 1..10}.',
      'Période : today (défaut si pertinent), yesterday, last7d, last30d.',
      'Question de capacité ou de présentation ("tu surveilles ?", "que sais-tu faire ?") → {"tool": null, "args": {}}.',
      'Question incompréhensible → {"tool": null, "args": {}}.',
      'Tu ne proposes JAMAIS d’action (suspendre, modifier, payer…) : ce n’est pas ton rôle.',
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
    const completion = await this.gateway.completeJson<unknown>({
      caller: 'AiAdminAgentSynth',
      messages: [
        { role: 'system', content: this.synthesisPrompt(now) },
        { role: 'user', content: `Question : ${question}\n${dataBlock}` },
      ],
      maxTokens: AI_AGENT_MAX_TOKENS,
      timeoutMs: this.aiConfig.chatTimeoutMs,
      correlationId: `ai-agent-synth-${Date.now()}`,
    });
    const record = asRecord(completion.result);
    const reply = typeof record?.reply === 'string' ? record.reply.trim() : null;
    if (!reply) return null;
    return {
      reply: truncate(reply, AI_AGENT_MAX_REPLY_CHARS),
      toolCalls: tool ? [{ tool, ok: toolData !== null }] : [],
      model: completion.model,
    };
  }

  private synthesisPrompt(now: Date): string {
    return [
      'Tu es l’Agent IA du back-office Relio. Tu aides exclusivement les administrateurs.',
      'Tu réponds UNIQUEMENT en JSON strict : {"reply": "texte de la réponse"}.',
      'Règles absolues :',
      '- toute statistique provient des données vérifiées ci-dessus ; sans données, dis que tu ne disposes pas de donnée structurée (n’invente jamais) ;',
      '- distingue donnée observée, calcul et interprétation ; estimation interdite sauf mention explicite ;',
      '- signaux IA-7/IA-8 = signaux à revue humaine, jamais des accusations ni des scores ; pas de classement de techniciens ;',
      '- avis à note basse = des avis, jamais des "plaintes" ;',
      '- si la question demande une action (suspendre, modifier, payer, envoyer…), refuse et renvoie vers les outils admin ;',
      '- réponse concise, en français, sans jargon inutile.',
      `Contexte temporel serveur : ${now.toISOString()} (fuseau métier ${AI_AGENT_TIMEZONE}).`,
    ].join('\n');
  }
}
