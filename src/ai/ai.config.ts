import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/* IA-1 — configuration du provider IA (GroqCloud depuis la migration
 * OpenRouter → Groq, voir docs/AI-GOVERNANCE.md), lue UNIQUEMENT côté backend.
 * Conventions reprises de `SasPayConfig` : getters typés, secrets jamais
 * exposés, `isConfigured()` pour refuser proprement sans secret.
 *
 * Variables (toutes optionnelles : sans elles le gateway refuse proprement) :
 * - `AI_ENABLED` ("true"/"false", défaut "false") : interrupteur global ;
 * - `GROQ_API_KEY` : clé secrète (`gsk-…`), backend uniquement, jamais loggée ;
 * - `GROQ_BASE_URL` : défaut officiel compatible OpenAI ci-dessous ;
 * - `GROQ_MODEL` : modèle principal (défaut ci-dessous) ;
 * - `GROQ_FALLBACK_MODEL` : modèle de repli FUTUR (lu, non utilisé —
 *   aucune bascule automatique) ;
 * - `GROQ_TIMEOUT_MS` : garde-fou par appel (défaut 30 s). */

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const GROQ_DEFAULT_TIMEOUT_MS = 30_000;
export const GROQ_MAX_TIMEOUT_MS = 120_000;

@Injectable()
export class AiConfig {
  constructor(private readonly config: ConfigService) {}

  /** Interrupteur global (défaut : désactivé, comportement neutre). */
  get enabled(): boolean {
    return this.config.get<string>('AI_ENABLED')?.trim().toLowerCase() === 'true';
  }

  /** Clé API secrète (`gsk-…`) — backend uniquement, jamais journalisée. */
  get apiKey(): string | null {
    const raw = this.config.get<string>('GROQ_API_KEY')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Base API compatible OpenAI (https exigée, slash final retiré). */
  get baseUrl(): string {
    const raw = this.config.get<string>('GROQ_BASE_URL')?.trim().replace(/\/+$/, '');
    return raw && raw.length > 0 ? raw : GROQ_DEFAULT_BASE_URL;
  }

  /** URL validée (https uniquement) — null si malformée/non-https. */
  validatedBaseUrl(): string | null {
    try {
      const parsed = new URL(this.baseUrl);
      return parsed.protocol === 'https:' && parsed.hostname ? this.baseUrl : null;
    } catch {
      return null;
    }
  }

  /** Modèle principal (configurable, jamais codé en dur en aval). */
  get model(): string {
    const raw = this.config.get<string>('GROQ_MODEL')?.trim();
    return raw && raw.length > 0 ? raw : GROQ_DEFAULT_MODEL;
  }

  /** Modèle de repli FUTUR (lu et exposé, aucun basculement auto — la
   *  décision d'activer un fallback reste explicite, jamais automatique). */
  get fallbackModel(): string | null {
    const raw = this.config.get<string>('GROQ_FALLBACK_MODEL')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Timeout par appel, borné [1 s, 120 s]. */
  get timeoutMs(): number {
    const raw = Number(this.config.get<string>('GROQ_TIMEOUT_MS'));
    if (!Number.isFinite(raw)) return GROQ_DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(Math.round(raw), 1000), GROQ_MAX_TIMEOUT_MS);
  }

  /* IA-4/IA-5 — seuil de confiance CENTRALISÉ (unique, jamais dispersé) :
   * `AI_CLASSIFICATION_MIN_CONFIDENCE` (défaut 0.7), borné [0, 1]. */
  get classificationMinConfidence(): number {
    const raw = Number(this.config.get<string>('AI_CLASSIFICATION_MIN_CONFIDENCE'));
    if (!Number.isFinite(raw)) return 0.7;
    return Math.min(Math.max(raw, 0), 1);
  }

  /* IA-4/IA-5 — timeout court CENTRALISÉ des classifications (défaut 8 s,
   * borné [1 s, 30 s]) : l'IA ne bloque jamais un workflow. */
  get classificationTimeoutMs(): number {
    const raw = Number(this.config.get<string>('AI_CLASSIFICATION_TIMEOUT_MS'));
    if (!Number.isFinite(raw)) return 8_000;
    return Math.min(Math.max(Math.round(raw), 1000), 30_000);
  }

  /* IA-8 — seuil de confiance CENTRALISÉ de la surveillance
   * conversationnelle (unique, jamais dispersé) :
   * `AI_CHAT_MIN_CONFIDENCE` (défaut 0.7), borné [0, 1]. En dessous,
   * aucun flag n'est créé (signal insuffisant). */
  get chatMinConfidence(): number {
    const raw = Number(this.config.get<string>('AI_CHAT_MIN_CONFIDENCE'));
    if (!Number.isFinite(raw)) return 0.7;
    return Math.min(Math.max(raw, 0), 1);
  }

  /* IA-8 — timeout court CENTRALISÉ de l'analyse, borné [1 s, 30 s].
   * IA-11.3 — défaut 8 s → 12 s : les échecs prod `unreadable_body`
   * clusterisaient exactement à la borne (durées agent 8001/8002/8004 ms
   * pour un timeout de 8000 ms = en-têtes HTTP 200 reçus puis lecture du
   * corps avortée par le signal). +50 % de marge pour absorber les pics
   * du fournisseur, sans dégrader l'interactivité (pire cas ≈ 2×12 s
   * plan+synthèse, fail-safe conservé). Surcharge : `AI_CHAT_TIMEOUT_MS`. */
  get chatTimeoutMs(): number {
    const raw = Number(this.config.get<string>('AI_CHAT_TIMEOUT_MS'));
    if (!Number.isFinite(raw)) return 12_000;
    return Math.min(Math.max(Math.round(raw), 1000), 30_000);
  }

  /* IA-11.2 — plafonds de sortie CENTRALISÉS de l'agent admin (plafonds
   * `max_tokens` du provider, raisonnement du fournisseur inclus) :
   * - plan : JSON de ~25-80 tokens ; 300 tokens provoquaient
   *   `finish_reason=length` à contenu vide (budget absorbé avant le
   *   contenu) → défaut 800 (marge ×3, pas de coût cible) ;
   * - synthèse : réponse courte (`reply` bornée à 4000 car. ≈ 1000
   *   tokens) + enveloppe JSON ; 800 tokens coupaient le JSON à ~680
   *   car. (`finish_reason=length`, ~1600 tokens de complétion
   *   comptés) → défaut 1500.
   * Surcharges d'exploitation (bornées) : `AI_AGENT_PLAN_MAX_TOKENS`
   * et `AI_AGENT_SYNTH_MAX_TOKENS` (noms indépendants du provider). */
  get agentPlanMaxTokens(): number {
    const raw = Number(this.config.get<string>('AI_AGENT_PLAN_MAX_TOKENS'));
    if (!Number.isFinite(raw)) return 800;
    return Math.min(Math.max(Math.round(raw), 200), 4000);
  }

  get agentSynthMaxTokens(): number {
    const raw = Number(this.config.get<string>('AI_AGENT_SYNTH_MAX_TOKENS'));
    if (!Number.isFinite(raw)) return 1500;
    return Math.min(Math.max(Math.round(raw), 400), 8000);
  }

  /* IA-11.4 — résilience HTTP 429 du provider (quotas : 30 req/min,
   * 8 000 tokens/min sur le plan GroqCloud utilisé — voir docs/AI-GOVERNANCE.md).
   * UN SEUL retry par appel (`maxRetries` borné [0, 1] : aucune boucle
   * possible, même en cas de mauvaise configuration) + backoff court
   * (défaut 1000 ms, borné [0, 10 s]). Le retry s'applique par appel
   * (planner OU synthesizer, jamais toute la chaîne) et UNIQUEMENT au
   * 429 : 4xx autres, timeouts, corps illisibles et erreurs métier ne sont
   * jamais rejoués. `0` = retry désactivé (repli opérateur). */
  get rateLimitMaxRetries(): number {
    const raw = Number(this.config.get<string>('AI_429_MAX_RETRIES'));
    if (!Number.isFinite(raw)) return 1;
    return Math.min(Math.max(Math.round(raw), 0), 1);
  }

  get rateLimitRetryDelayMs(): number {
    const raw = Number(this.config.get<string>('AI_429_RETRY_DELAY_MS'));
    if (!Number.isFinite(raw)) return 1000;
    return Math.min(Math.max(Math.round(raw), 0), 10_000);
  }

  /** Vrai si un appel peut être tenté (activé + clé + URL https). */
  isConfigured(): boolean {
    return this.enabled && this.apiKey !== null && this.validatedBaseUrl() !== null;
  }

  /** Motif de refus (sans secret), null si appelable. */
  refusalReason(): string | null {
    if (!this.enabled) return 'IA désactivée (AI_ENABLED=false)';
    if (!this.apiKey) return 'clé API Groq absente';
    if (!this.validatedBaseUrl()) return 'URL Groq invalide (https requise)';
    return null;
  }
}
