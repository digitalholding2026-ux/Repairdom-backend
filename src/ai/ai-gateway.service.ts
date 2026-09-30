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

  /** Complétion + parse JSON (encapsulation ```/prose tolérée, syntaxe jamais réparée). */
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

/* IA-11.1 — extraction JSON robuste (les modèles encapsulent parfois le
 * JSON : fence ```json, prose avant/après). Stratégie, sans JAMAIS réparer
 * la syntaxe (pas de JSON5, pas de correction de clés, pas de contenu
 * inventé) :
 *  1. JSON pur (cas nominal, rapide) ;
 *  2. premier bloc fenced (```json … ``` ou ``` … ```), contenu parsé ;
 *  3. première structure {…} ou […] équilibrée du texte (chaînes et
 *     échappements respectés) — refusée si le reste contient une SECONDE
 *     structure JSON valide (ambiguïté → invalide, pas d'arbitraire).
 * `undefined` si rien de récupérable : l'appelant conserve son fail-open
 * (contrat validé en aval, inchangé). Travail borné (MAX_SCAN_CHARS). */

const JSON_SCAN_LIMIT = 32_768;

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Première structure {…}/[…] équilibrée depuis `start` (pile d'attentes,
 *  chaînes "..." et `\` respectés). `null` si tronquée ou malformée. */
function scanBalancedStructure(text: string, start: number): { candidate: string; rest: string } | null {
  const closers: Record<string, string> = { '{': '}', '[': ']' };
  const expected: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      expected.push(closers[ch]);
    } else if (ch === '}' || ch === ']') {
      if (expected.pop() !== ch) return null;
      if (expected.length === 0) {
        return { candidate: text.slice(start, i + 1), rest: text.slice(i + 1) };
      }
    }
  }
  return null;
}

/** Vrai si le texte contient une structure JSON valide (ambiguïté). */
function containsValidJsonStructure(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const scanned = scanBalancedStructure(text, i);
    if (scanned && tryParseJson(scanned.candidate).ok) return true;
  }
  return false;
}

/** Parse JSON tolérant à l'encapsulation (fence, prose). `undefined` si
 *  le corps ne contient aucune structure JSON valide et non ambiguë. */
export function parseJsonBody(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // 1. JSON pur.
  const direct = tryParseJson(trimmed);
  if (direct.ok) return direct.value;
  if (trimmed.length > JSON_SCAN_LIMIT) return undefined;
  // 2. Premier bloc fenced.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const inner = tryParseJson(fence[1].trim());
    if (inner.ok) return inner.value;
  }
  // 3. Première structure équilibrée (reste sans seconde structure valide).
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{' || trimmed[i] === '[') {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const scanned = scanBalancedStructure(trimmed, start);
  if (!scanned) return undefined;
  const parsed = tryParseJson(scanned.candidate);
  if (!parsed.ok) return undefined;
  if (containsValidJsonStructure(scanned.rest)) return undefined;
  return parsed.value;
}
