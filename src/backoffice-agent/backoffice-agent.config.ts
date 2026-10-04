import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/* Agent Backoffice (lecture seule, à la demande) — configuration minimale.
 * Seules 3 variables, toutes optionnelles : sans GROQ_API_KEY l'agent se
 * déclare indisponible (aucun comportement métier ne change, aucune autre
 * variable IA historique n'est lue). La clé reste backend uniquement,
 * jamais exposée, jamais journalisée. */

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const GROQ_DEFAULT_TIMEOUT_MS = 30000;

@Injectable()
export class BackofficeAgentConfig {
  constructor(private readonly config: ConfigService) {}

  get apiKey(): string {
    return (this.config.get<string>('GROQ_API_KEY') ?? '').trim();
  }

  get baseUrl(): string {
    const raw = (this.config.get<string>('GROQ_BASE_URL') ?? '').trim().replace(/\/+$/, '');
    return raw.length > 0 ? raw : GROQ_DEFAULT_BASE_URL;
  }

  get model(): string {
    const raw = (this.config.get<string>('GROQ_MODEL') ?? '').trim();
    return raw.length > 0 ? raw : GROQ_DEFAULT_MODEL;
  }

  get timeoutMs(): number {
    return GROQ_DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  refusalReason(): string | null {
    if (!this.isConfigured()) {
      return "L'assistant est momentanément indisponible (service non configuré).";
    }
    return null;
  }
}
