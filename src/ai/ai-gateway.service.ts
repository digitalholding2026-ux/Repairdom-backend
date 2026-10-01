import { Injectable, Logger } from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import {
  AiDisabledException,
  AiInvalidResponseException,
  AiTerminalException,
  AiUpstreamException,
} from './ai-errors.js';

/* IA-1 — AI Gateway centralisé (SEUL point d'accès au provider IA,
 * GroqCloud depuis la migration OpenRouter → Groq, voir docs/AI-GOVERNANCE.md).
 *
 * Règles absolues :
 * - AUCUNE règle métier ici (générique et réutilisable) ;
 * - AUCUN appel métier existant ne dépend du gateway en IA-1 ;
 * - AUCUNE route publique `/ai/...` (usage backend interne uniquement) ;
 * - AUCUN secret dans logs/erreurs (clé expurgée défensivement) ;
 * - AUCUN contenu sensible loggé (ni prompts complets, ni PII) ;
 * - AUCUN retry automatique sauf 429 borné IA-11.4 (l'appelant ne réessaie
 *   jamais lui-même, backoff à la charge du gateway).
 *
 * Endpoint compatible OpenAI : POST `{baseUrl}/chat/completions`
 * (GroqCloud : base `https://api.groq.com/openai/v1`, clé `gsk-…`). */

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

/* Corps compatible OpenAI, non-streaming (jamais de `stream`) :
 * `max_tokens` et `temperature` optionnels, le reste obligatoire.
 * GroqCloud accepte le même format (pas de `response_format` envoyé :
 * le JSON strict reste exigé par les prompts + toléré par le parser). */
interface ProviderRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  /** Texte brut du premier choix (jamais null ici : sinon erreur). */
  result: string;
  model: string;
  usage?: AiTokenUsage;
  durationMs: number;
  /* IA-11.2 — motif d'arrêt du provider (`stop`, `length`, …) : `length`
   * signale une troncature par `max_tokens` (réponse refusée en aval,
   * jamais réparée). */
  finishReason: string | null;
}

export interface AiJsonResult<T = unknown> {
  /** Valeur JSON parsée (jamais de texte brut ici). */
  result: T;
  model: string;
  usage?: AiTokenUsage;
  durationMs: number;
  /* IA-11.2 — motif d'arrêt du provider (voir `AiCompletionResult`). */
  finishReason: string | null;
}

/* Expurge défensivement toute trace de secret d'une chaîne loggée
 * (clé Groq `gsk-…`, ancien format `sk-or-…`, header Authorization) —
 * ceinture + bretelles, la clé n'étant de toute façon jamais interpolée
 * dans les logs. */
const SECRET_VALUE_PATTERN = /(?:gsk-|sk-or-)[A-Za-z0-9_-]+/g;
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

/* IA-11.3 — vrai si l'échec vient de l'expiration du timeout : signal
 * avorté (fetch OU lecture du corps en cours), ou erreur nommée
 * `TimeoutError`/`AbortError` (DOM : avort pendant `response.text()`). */
function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/* IA-11.4 — plafond du délai issu de `Retry-After` (jamais d'attente
 * longue : le retry 429 reste un court backoff, pas une file d'attente). */
export const MAX_429_RETRY_AFTER_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* IA-11.4 — délai avant retry 429 : `Retry-After` du fournisseur (secondes
 * ou date HTTP) lorsqu'il est exploitable et borné, sinon le backoff
 * configuré. Pur et testable unitairement (aucun réseau, aucune attente). */
export function resolveRetryDelayMs(retryAfterHeader: string | null, defaultDelayMs: number): number {
  if (retryAfterHeader) {
    const raw = retryAfterHeader.trim();
    if (raw) {
      const seconds = Number(raw);
      if (!Number.isNaN(seconds)) {
        // Forme numérique : négatif ou infini = invalide → défaut (un
        // `Date.parse` aveugle interpréterait "-2" comme une année).
        if (seconds < 0 || !Number.isFinite(seconds)) return defaultDelayMs;
        return Math.min(Math.floor(seconds * 1000), MAX_429_RETRY_AFTER_MS);
      }
      const at = Date.parse(raw);
      if (!Number.isNaN(at)) {
        return Math.min(Math.max(at - Date.now(), 0), MAX_429_RETRY_AFTER_MS);
      }
    }
  }
  return defaultDelayMs;
}

/* Contenu OpenAI-style en parties [{type:'text', text:'…'}] ou ['…'] :
 * concaténation pure (aucune réparation, aucun contenu inventé). */
function joinTextParts(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const chunks: string[] = [];
  for (const part of raw) {
    if (typeof part === 'string' && part.trim()) {
      chunks.push(part);
      continue;
    }
    const record = asRecord(part);
    const text = asNonEmptyString(record?.text);
    if (text) chunks.push(text);
  }
  const joined = chunks.join('').trim();
  return joined ? joined : null;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[TRONQUE]` : text;
}

/* Hôte du provider pour les logs (ex. `api.groq.com`) : jamais la clé,
 * jamais le chemin. `unknown` si l'URL est malformée (refusé en amont). */
function providerHost(baseUrl: string | null): string {
  if (!baseUrl) return 'unknown';
  try {
    return new URL(baseUrl).hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(private readonly config: AiConfig) {}

  /* Complétion texte via le provider IA (erreur interne propre sinon).
   * IA-11.3 — séquence instrumentée, mode NON-streaming (aucun `stream`
   * envoyé : le provider répond en JSON complet, jamais en flux) :
   *   fetch (signal timeout conservé) → statut HTTP (en-têtes) → lecture
   *   du corps en texte (métadonnées seules : longueur, MIME) → parse →
   *   forme compatible OpenAI → contenu. Chaque étape a sa classification
   *   (`request_timeout` vs `body_read_error` vs statuts vs forme),
   *   sans JAMAIS logger le corps, les prompts ou des secrets.
   * IA-11.4 — retry contrôlé UNIQUEMENT sur HTTP 429 (`upstream_rate_limited`,
   *   typique du plan gratuit) : 1 retry max par appel (boucle `for` bornée
   *   par `rateLimitMaxRetries` ∈ [0, 1], donc ≤ 2 tentatives au total,
   *   AUCUNE boucle), backoff court (`rateLimitRetryDelayMs`, `Retry-After`
   *   borné préféré). Chaque appel (planner OU synthesizer) rejoue au plus
   *   sa propre tentative : jamais de relance de la chaîne complète, jamais
   *   de retry sur 4xx autres / timeout / corps illisible / métier. */
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
      throw new AiDisabledException('Appel IA impossible : URL Groq invalide (https requise).');
    }
    const body: ProviderRequestBody = {
      model: input.model?.trim() || this.config.model,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    };
    const maxRetries = this.config.rateLimitMaxRetries;
    const baseDelayMs = this.config.rateLimitRetryDelayMs;
    const correlation = input.correlationId ? ` correlation=${truncate(input.correlationId, 64)}` : '';
    // Boucle bornée : `attempt` ne peut jamais dépasser `maxRetries + 1`
    // (≤ 2). Toute autre erreur quitte par `throw` dans `attemptComplete`.
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const outcome = await this.attemptComplete(input, body, baseUrl, startedAt);
      if (outcome.ok) return outcome.value;
      if (attempt > maxRetries) {
        this.logger.warn(scrubSecrets(`AI 429 exhausted caller=${input.caller} attempts=${attempt}${correlation}`));
        throw new AiUpstreamException('Service IA temporairement indisponible.', 429, 'upstream_rate_limited');
      }
      const delayMs = resolveRetryDelayMs(outcome.retryAfterHeader, baseDelayMs);
      this.logger.warn(
        scrubSecrets(
          `AI 429 retry caller=${input.caller} attempt=${attempt + 1} delayMs=${delayMs} ` +
            `delaySource=${outcome.retryAfterHeader ? 'retry-after' : 'default'}${correlation}`,
        ),
      );
      await sleep(delayMs);
    }
    // Inatteignable (la boucle retourne ou lève toujours) — garde-fou typé.
    throw new AiUpstreamException('Service IA temporairement indisponible.', 429, 'upstream_rate_limited');
  }

  /* Une seule tentative réseau (signal timeout frais par tentative : chaque
   * essai dispose de son budget complet). Retourne le résultat OU, pour le
   * seul cas rejouable (HTTP 429), l'en-tête `Retry-After` ; tout le reste
   * lève immédiatement (aucun retry). */
  private async attemptComplete(
    input: AiCompletionInput,
    body: ProviderRequestBody,
    baseUrl: string,
    startedAt: number,
  ): Promise<
    | { readonly ok: true; readonly value: AiCompletionResult }
    | { readonly ok: false; readonly retryAfterHeader: string | null }
  > {
    // Signal conservé en référence : distingue l'avort par timeout
    // (pendant fetch OU pendant la lecture du corps) des autres erreurs.
    const timeoutSignal = AbortSignal.timeout(Math.min(input.timeoutMs ?? this.config.timeoutMs, 120_000));
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
        signal: timeoutSignal,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timedOut = isTimeoutError(error, timeoutSignal);
      const reason = timedOut ? 'timeout' : 'réseau';
      this.logCall(
        input,
        'upstream',
        durationMs,
        `${timedOut ? 'request_timeout' : 'request_network_error'} elapsedMs=${durationMs} ` +
          `abortReason=${timedOut ? 'timeout' : 'none'}`,
      );
      throw new AiUpstreamException(
        `Service IA temporairement indisponible (${reason}).`,
        null,
        timedOut ? 'request_timeout' : 'request_network_error',
        timedOut ? 'timeout' : 'none',
      );
    }
    const headersAt = Date.now();
    // Statut d'abord (en-têtes déjà reçus) : inutile de lire le corps
    // d'une erreur sous contrainte de timeout.
    if (response.status === 429) {
      const durationMs = Date.now() - startedAt;
      this.logCall(input, 'upstream', durationMs, `HTTP 429 upstream_rate_limited elapsedMs=${durationMs}`);
      // Seul cas rejouable : la boucle `complete()` décide (retry borné).
      return { ok: false, retryAfterHeader: response.headers?.get('retry-after') ?? null };
    }
    if (response.status >= 500) {
      const durationMs = Date.now() - startedAt;
      this.logCall(
        input,
        'upstream',
        durationMs,
        `HTTP ${response.status} upstream_server_error elapsedMs=${durationMs}`,
      );
      throw new AiUpstreamException(
        'Service IA temporairement indisponible.',
        response.status,
        'upstream_server_error',
      );
    }
    if (response.status >= 400) {
      const durationMs = Date.now() - startedAt;
      this.logCall(input, 'terminal', durationMs, `HTTP ${response.status} provider_refused`);
      throw new AiTerminalException('Requête IA refusée par le fournisseur.', response.status, 'provider_refused');
    }
    // Corps lu en texte : seule la LONGUEUR et le MIME sont exploités
    // (jamais le contenu). `bodyLength=0` = corps vide ; lecture avortée
    // avec `abortReason=timeout` = cas prod HTTP 200 à ~timeout.
    const mimeType = truncate(response.headers?.get('content-type') ?? 'unknown', 80);
    let rawBody = '';
    let bodyReadCompleted = false;
    try {
      rawBody = await response.text();
      bodyReadCompleted = true;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timedOut = isTimeoutError(error, timeoutSignal);
      this.logCall(
        input,
        'invalid',
        durationMs,
          `HTTP ${response.status} body_read_error bodyReadStarted=true bodyReadCompleted=${bodyReadCompleted} ` +
          `bodyLength=unknown contentType=${mimeType} abortReason=${timedOut ? 'timeout' : 'none'} ` +
          `bodyReadMs=${Date.now() - headersAt} elapsedMs=${durationMs}`,
      );
      throw new AiInvalidResponseException(
        'Réponse IA illisible.',
        null,
        'body_read_error',
        timedOut ? 'timeout' : 'none',
      );
    }
    const durationMs = Date.now() - startedAt;
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      this.logCall(
        input,
        'invalid',
        durationMs,
          `HTTP ${response.status} body_read_error bodyReadStarted=true bodyReadCompleted=${bodyReadCompleted} ` +
          `bodyLength=${rawBody.length} contentType=${mimeType} abortReason=none ` +
          `bodyReadMs=${Date.now() - headersAt} elapsedMs=${durationMs}`,
      );
      throw new AiInvalidResponseException('Réponse IA illisible.', null, 'body_read_error', 'none');
    }
    const record = asRecord(payload);
    const data = asRecord(record?.data) ?? record ?? {};
    const choices = Array.isArray(data.choices) ? data.choices : null;
    const firstChoice = asRecord(choices?.[0]);
    const messageRecord = asRecord(firstChoice?.message);
    const rawContent: unknown = messageRecord ? messageRecord.content : null;
    // Certains fournisseurs/modeles renvoient le texte en parties
    // `[{type:'text', text:'…'}]` : concaténation pure, jamais de réparation.
    const content = asNonEmptyString(rawContent) ?? joinTextParts(rawContent);
    const finishReason = asNonEmptyString(firstChoice?.finish_reason) ?? null;
    if (!content) {
      const contentType =
        rawContent === null || rawContent === undefined
          ? 'missing'
          : Array.isArray(rawContent)
            ? 'array'
            : typeof rawContent;
      this.logCall(
        input,
        'invalid',
        durationMs,
        `HTTP ${response.status} invalid_provider_payload choicesCount=${choices?.length ?? 0} ` +
          `messagePresent=${messageRecord !== null} contentType=${contentType} ` +
          `bodyLength=${rawBody.length} finishReason=${finishReason ?? 'unknown'}`,
      );
      throw new AiInvalidResponseException('Réponse IA inexploitable.', finishReason, 'invalid_provider_payload');
    }
    const usageRecord = asRecord(data.usage) ?? undefined;
    const result: AiCompletionResult = {
      result: content,
      model: asNonEmptyString(data.model) ?? body.model,
      finishReason,
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
    return { ok: true, value: result };
  }

  /** Complétion + parse JSON (encapsulation ```/prose tolérée, syntaxe jamais réparée).
   *  Échec → log de diagnostic SANS contenu (métadonnées seules), puis
   *  erreur propre inchangée (aucun impact contrat/frontend). */
  async completeJson<T = unknown>(input: AiCompletionInput): Promise<AiJsonResult<T>> {
    const completion = await this.complete(input);
    const detailed = parseJsonDetailed(completion.result);
    if (!detailed.ok) {
      const diagnosis = detailed.diagnosis;
      this.logger.warn(
        scrubSecrets(
          `AI caller=${input.caller} status=invalid parseStage=${detailed.parseStage} ` +
            `failureReason=${detailed.failureReason} durationMs=${completion.durationMs} ` +
            `finishReason=${completion.finishReason ?? 'unknown'} ` +
            `responseLength=${diagnosis.responseLength} ` +
            `firstChar=${diagnosis.firstNonWhitespaceChar ?? 'none'} ` +
            `lastChar=${diagnosis.lastNonWhitespaceChar ?? 'none'} ` +
            `hasMarkdownFence=${diagnosis.hasMarkdownFence} ` +
            `extractionAttempted=${diagnosis.jsonExtractionAttempted} ` +
            `extractionSucceeded=${diagnosis.jsonExtractionSucceeded} ` +
            `jsonParseSucceeded=${diagnosis.jsonParseSucceeded}`,
        ),
      );
      throw new AiInvalidResponseException('Réponse IA non-JSON.', completion.finishReason);
    }
    return { ...completion, result: detailed.value as T };
  }

  /* Log technique borné : provider (hôte base URL, jamais la clé),
   * appelant, modèle, durée, statut, tokens.
   * Jamais : prompts/contenus, PII, clé, Authorization. */
  private logCall(
    input: AiCompletionInput,
    status: 'ok' | 'refused' | 'upstream' | 'terminal' | 'invalid',
    durationMs: number,
    detail: string,
    totalTokens?: number,
  ): void {
    const line =
      `AI provider=${providerHost(this.config.validatedBaseUrl())} caller=${input.caller} ` +
      `model=${input.model?.trim() || this.config.model} ` +
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

/* IA-11 diagnostic sécurisé — métadonnées techniques SANS contenu.
 *  Jamais : texte de la réponse, prompts, PII, clés, données métier. */
export interface AiJsonContentDiagnosis {
  responseLength: number;
  firstNonWhitespaceChar: string | null;
  lastNonWhitespaceChar: string | null;
  hasMarkdownFence: boolean;
  jsonExtractionAttempted: boolean;
  jsonExtractionSucceeded: boolean;
  jsonParseSucceeded: boolean;
}

export type AiJsonParseStage = 'extraction' | 'json_parse';

export type AiJsonParseFailureReason =
  | 'empty_response'
  | 'oversize'
  | 'no_json_structure'
  | 'truncated_structure'
  | 'unexpected_token'
  | 'ambiguous_multiple_json';

export type AiJsonParseDetailedResult =
  | { ok: true; value: unknown; diagnosis: AiJsonContentDiagnosis }
  | {
      ok: false;
      parseStage: AiJsonParseStage;
      failureReason: AiJsonParseFailureReason;
      diagnosis: AiJsonContentDiagnosis;
    };

function firstNonWhitespaceCharOf(text: string): string | null {
  for (const ch of text) {
    if (ch.trim()) return ch;
  }
  return null;
}

function lastNonWhitespaceCharOf(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i].trim()) return text[i];
  }
  return null;
}

/** Parse JSON détaillé : même acceptation que `parseJsonBody`, avec en
 *  plus l'étape exacte d'échec (`extraction` vs `json_parse`) et des
 *  métadonnées sans contenu. Aucune réparation sémantique. */
export function parseJsonDetailed(text: string): AiJsonParseDetailedResult {
  const trimmed = text.trim();
  const base = {
    responseLength: text.length,
    firstNonWhitespaceChar: firstNonWhitespaceCharOf(trimmed),
    lastNonWhitespaceChar: lastNonWhitespaceCharOf(trimmed),
    hasMarkdownFence: trimmed.includes('```'),
  };
  const fail = (
    parseStage: AiJsonParseStage,
    failureReason: AiJsonParseFailureReason,
    extra: Partial<AiJsonContentDiagnosis> = {},
  ): AiJsonParseDetailedResult => ({
    ok: false,
    parseStage,
    failureReason,
    diagnosis: {
      ...base,
      jsonExtractionAttempted: false,
      jsonExtractionSucceeded: false,
      jsonParseSucceeded: false,
      ...extra,
    },
  });
  if (!trimmed) return fail('extraction', 'empty_response');
  // 1. JSON pur.
  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    return {
      ok: true,
      value: direct.value,
      diagnosis: {
        ...base,
        jsonExtractionAttempted: true,
        jsonExtractionSucceeded: true,
        jsonParseSucceeded: true,
      },
    };
  }
  if (trimmed.length > JSON_SCAN_LIMIT) return fail('extraction', 'oversize');
  // 2. Premier bloc fenced.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    const inner = tryParseJson(fence[1].trim());
    if (inner.ok) {
      return {
        ok: true,
        value: inner.value,
        diagnosis: {
          ...base,
          jsonExtractionAttempted: true,
          jsonExtractionSucceeded: true,
          jsonParseSucceeded: true,
        },
      };
    }
  }
  // 3. Première structure équilibrée (reste sans seconde structure valide).
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{' || trimmed[i] === '[') {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return fail('extraction', 'no_json_structure', {
      jsonExtractionAttempted: base.hasMarkdownFence,
    });
  }
  const scanned = scanBalancedStructure(trimmed, start);
  if (!scanned) return fail('extraction', 'truncated_structure', { jsonExtractionAttempted: true });
  const parsed = tryParseJson(scanned.candidate);
  if (!parsed.ok) {
    return fail('json_parse', 'unexpected_token', { jsonExtractionAttempted: true });
  }
  if (containsValidJsonStructure(scanned.rest)) {
    return fail('json_parse', 'ambiguous_multiple_json', {
      jsonExtractionAttempted: true,
      jsonExtractionSucceeded: true,
      jsonParseSucceeded: true,
    });
  }
  return {
    ok: true,
    value: parsed.value,
    diagnosis: {
      ...base,
      jsonExtractionAttempted: true,
      jsonExtractionSucceeded: true,
      jsonParseSucceeded: true,
    },
  };
}

/** Parse JSON tolérant à l'encapsulation (fence, prose). `undefined` si
 *  le corps ne contient aucune structure JSON valide et non ambiguë. */
export function parseJsonBody(text: string): unknown | undefined {
  const detailed = parseJsonDetailed(text);
  return detailed.ok ? detailed.value : undefined;
}
