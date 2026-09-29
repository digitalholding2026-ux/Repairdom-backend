import { Injectable, Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import {
  AiDisabledException,
  AiInvalidResponseException,
  AiTerminalException,
  AiUpstreamException,
} from './ai-errors.js';

/* IA-1 — AI Gateway centralisé (SEUL point d'accès à OpenRouter).
 *
 * Règles absolues :
 * - AUCUNE règle métier ici (générique et réutilisable) ;
 * - AUCUN appel métier existant ne dépend du gateway en IA-1 ;
 * - AUCUNE route publique `/ai/...` (usage backend interne uniquement) ;
 * - AUCUN secret dans logs/erreurs (clé expurgée défensivement) ;
 * - AUCUN contenu sensible loggé (ni prompts complets, ni PII) ;
 * - AUCUN retry automatique (l'appelant décide, backoff à sa charge).
 *
 * Endpoint OpenAI-compatible : POST `{baseUrl}/chat/completions`. */

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionInput {
  /** Nom du service appelant (logs uniquement, ex. 'PricingMonitor'). */
  caller: string;
  messages: AiChatMessage[];
  /** Surcharge ponctuelle du modèle (défaut : modèle principal configuré). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Surcharge ponctuelle du timeout (bornée par la config). */
  timeoutMs?: number;
  /** Identifiant de corrélation existant (logs uniquement). */
  correlationId?: string;
}

export interface AiTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiCompletionResult {
  /** Texte brut du premier choix (jamais null ici : sinon erreur). */
  result: string;
  model: string;
  usage?: AiTokenUsage;
  durationMs: number;
}

export interface AiJsonResult<T = unknown> {
  /** Valeur JSON parsée (jamais de texte brut ici). */
  result: T;
  model: string;
  usage?: AiTokenUsage;
  durationMs: number;
}

/* Expurge défensivement toute trace de secret d'une chaîne loggée
 * (clé `sk-or-…`, header Authorization) — ceinture + bretelles, la clé
 * n'étant de toute façon jamais interpolée dans les logs. */
const SECRET_VALUE_PATTERN = /sk-or-[A-Za-z0-9_-]+/g;
const AUTH_HEADER_PATTERN = /authorization\s*:\s*[^\s,}]+/gi;

function scrubSecrets(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, '[REDACTED]').replace(AUTH_HEADER_PATTERN, 'authorization: [REDACTED]');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[TRONQUE]` : text;
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(private readonly config: AiConfig) {}

  /** Complétion texte via OpenRouter (erreur interne propre sinon). */
  async complete(input: AiCompletionInput): Promise<AiCompletionResult> {
    const startedAt = Date.now();
    const refusal = this.config.refusalReason();
    if (refusal) {
      this.logCall(input, 'refused', Date.now() - startedAt, refusal);
      throw new AiDisabledException(`Appel IA impossible : ${refusal}.`);
    }
    const baseUrl = this.config.validatedBaseUrl();
    if (!baseUrl) {
      // Garde-fou (refusalReason couvre déjà ce cas).
      throw new AiDisabledException('Appel IA impossible : URL OpenRouter invalide (https requise).');
    }
    const body = {
      model: input.model?.trim() || this.config.model,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Clé en en-tête sortant uniquement — jamais journalisée.
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(input.timeoutMs ?? this.config.timeoutMs, 120_000)),
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'réseau';
      this.logCall(input, 'upstream', durationMs, reason);
      throw new AiUpstreamException(`Service IA temporairement indisponible (${reason}).`);
    }
    const durationMs = Date.now() - startedAt;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.logCall(input, 'invalid', durationMs, `HTTP ${response.status}`);
      throw new AiInvalidResponseException('Réponse IA illisible.');
    }
    if (response.status === 429 || response.status >= 500) {
      this.logCall(input, 'upstream', durationMs, `HTTP ${response.status}`);
      throw new AiUpstreamException('Service IA temporairement indisponible.', response.status);
    }
    if (response.status >= 400) {
      this.logCall(input, 'terminal', durationMs, `HTTP ${response.status}`);
      throw new AiTerminalException('Requête IA refusée par le fournisseur.', response.status);
    }
    const record = asRecord(payload);
    const data = asRecord(record?.data) ?? record ?? {};
    const choices = Array.isArray(data.choices) ? data.choices : null;
    const content = asNonEmptyString(asRecord(choices?.[0])?.message ? asRecord(asRecord(choices?.[0])?.message)?.content : null);
    if (!content) {
      this.logCall(input, 'invalid', durationMs, `HTTP ${response.status}`);
      throw new AiInvalidResponseException('Réponse IA inexploitable.');
    }
    const usageRecord = asRecord(data.usage) ?? undefined;
    const result: AiCompletionResult = {
      result: content,
      model: asNonEmptyString(data.model) ?? body.model,
      ...(usageRecord
        ? {
            usage: {
              ...(asFiniteNumber(usageRecord.prompt_tokens) !== null
                ? { promptTokens: asFiniteNumber(usageRecord.prompt_tokens) as number }
                : {}),
              ...(asFiniteNumber(usageRecord.completion_tokens) !== null
                ? { completionTokens: asFiniteNumber(usageRecord.completion_tokens) as number }
                : {}),
              ...(asFiniteNumber(usageRecord.total_tokens) !== null
                ? { totalTokens: asFiniteNumber(usageRecord.total_tokens) as number }
                : {}),
            },
          }
        : {}),
      durationMs,
    };
    this.logCall(input, 'ok', durationMs, result.model, result.usage?.totalTokens);
    return result;
  }

  /** Complétion + parse JSON strict (blocs ``` éventuels tolérés). */
  async completeJson<T = unknown>(input: AiCompletionInput): Promise<AiJsonResult<T>> {
    const completion = await this.complete(input);
    const parsed = parseJsonBody(completion.result);
    if (parsed === undefined) {
      throw new AiInvalidResponseException('Réponse IA non-JSON.');
    }
    return { ...completion, result: parsed as T };
  }

  /* Log technique borné : appelant, modèle, durée, statut, tokens.
   * Jamais : prompts/contenus, PII, clé, Authorization. */
  private logCall(
    input: AiCompletionInput,
    status: 'ok' | 'refused' | 'upstream' | 'terminal' | 'invalid',
    durationMs: number,
    detail: string,
    totalTokens?: number,
  ): void {
    const line =
      `AI caller=${input.caller} model=${input.model?.trim() || this.config.model} ` +
      `messages=${input.messages.length} status=${status} durationMs=${durationMs} ` +
      `${totalTokens !== undefined ? `tokens=${totalTokens} ` : ''}` +
      `detail=${truncate(detail, 160)}` +
      `${input.correlationId ? ` correlation=${truncate(input.correlationId, 64)}` : ''}`;
    if (status === 'ok') {
      this.logger.log(scrubSecrets(line));
    } else {
      this.logger.warn(scrubSecrets(line));
    }
  }
}

/** Parse JSON tolérant aux blocs markdown (```json … ```). `undefined` si
 *  le corps n'est pas du JSON. */
export function parseJsonBody(text: string): unknown | undefined {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!clean) return undefined;
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return undefined;
  }
}
