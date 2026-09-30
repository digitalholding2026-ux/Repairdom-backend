import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/* IA-1 — configuration OpenRouter, lue UNIQUEMENT côté backend.
 * Conventions reprises de `SasPayConfig` : getters typés, secrets jamais
 * exposés, `isConfigured()` pour refuser proprement sans secret.
 *
 * Variables (toutes optionnelles : sans elles le gateway refuse proprement) :
 * - `AI_ENABLED` ("true"/"false", défaut "false") : interrupteur global ;
 * - `OPENROUTER_API_KEY` : clé secrète, backend uniquement, jamais loggée ;
 * - `OPENROUTER_BASE_URL` : défaut officiel `https://openrouter.ai/api/v1` ;
 * - `OPENROUTER_MODEL` : modèle principal (défaut ci-dessous) ;
 * - `OPENROUTER_FALLBACK_MODEL` : modèle de repli FUTUR (lu, non utilisé
 *   en IA-1 — aucun retry automatique) ;
 * - `OPENROUTER_TIMEOUT_MS` : garde-fou par appel (défaut 30 s). */

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 30_000;
export const OPENROUTER_MAX_TIMEOUT_MS = 120_000;

@Injectable()
export class AiConfig {
  constructor(private readonly config: ConfigService) {}

  /** Interrupteur global (défaut : désactivé, comportement neutre). */
  get enabled(): boolean {
    return this.config.get<string>('AI_ENABLED')?.trim().toLowerCase() === 'true';
  }

  /** Clé API secrète — backend uniquement, jamais journalisée. */
  get apiKey(): string | null {
    const raw = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Base API (https exigée, slash final retiré). */
  get baseUrl(): string {
    const raw = this.config.get<string>('OPENROUTER_BASE_URL')?.trim().replace(/\/+$/, '');
    return raw && raw.length > 0 ? raw : OPENROUTER_DEFAULT_BASE_URL;
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
    const raw = this.config.get<string>('OPENROUTER_MODEL')?.trim();
    return raw && raw.length > 0 ? raw : OPENROUTER_DEFAULT_MODEL;
  }

  /** Modèle de repli FUTUR (IA-1 : lu et exposé, aucun basculement auto). */
  get fallbackModel(): string | null {
    const raw = this.config.get<string>('OPENROUTER_FALLBACK_MODEL')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Timeout par appel, borné [1 s, 120 s]. */
  get timeoutMs(): number {
    const raw = Number(this.config.get<string>('OPENROUTER_TIMEOUT_MS'));
    if (!Number.isFinite(raw)) return OPENROUTER_DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(Math.round(raw), 1000), OPENROUTER_MAX_TIMEOUT_MS);
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

  /* IA-8 — timeout court CENTRALISÉ de l'analyse (défaut 8 s, borné
   * [1 s, 30 s]) : le chat ne bloque jamais sur l'IA. */
  get chatTimeoutMs(): number {
    const raw = Number(this.config.get<string>('AI_CHAT_TIMEOUT_MS'));
    if (!Number.isFinite(raw)) return 8_000;
    return Math.min(Math.max(Math.round(raw), 1000), 30_000);
  }

  /** Vrai si un appel peut être tenté (activé + clé + URL https). */
  isConfigured(): boolean {
    return this.enabled && this.apiKey !== null && this.validatedBaseUrl() !== null;
  }

  /** Motif de refus (sans secret), null si appelable. */
  refusalReason(): string | null {
    if (!this.enabled) return 'IA désactivée (AI_ENABLED=false)';
    if (!this.apiKey) return 'clé API OpenRouter absente';
    if (!this.validatedBaseUrl()) return 'URL OpenRouter invalide (https requise)';
    return null;
  }
}
