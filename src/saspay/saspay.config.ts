import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Configuration SasPay, lue UNIQUEMENT côté backend (fondations SASPAY-01).
 *  Aucune clé secrète n'est exposée au frontend. Le mode TEST/REAL reste
 *  contrôlé par le backend ; `isConfigured()` permet de refuser proprement
 *  toute opération tant que les secrets sont absents. */
@Injectable()
export class SasPayConfig {
  constructor(private readonly config: ConfigService) {}

  /** Base API SasPay (défaut officiel). */
  get baseUrl(): string {
    const raw = this.config.get<string>('SASPAY_BASE_URL')?.trim();
    return raw && raw.length > 0 ? raw.replace(/\/+$/, '') : 'https://api.saspay.me/api/v1';
  }

  /** Mode prestataire : TEST par défaut, jamais décidé par le frontend. */
  get mode(): 'TEST' | 'LIVE' {
    const raw = this.config.get<string>('SASPAY_MODE')?.trim().toUpperCase();
    return raw === 'LIVE' ? 'LIVE' : 'TEST';
  }

  /** Clé API secrète (sk_test_… / sk_live_…) — backend uniquement. */
  get apiKey(): string | null {
    const raw = this.config.get<string>('SASPAY_API_KEY')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Secret de signature des webhooks (X-Webhook-Signature). */
  get webhookSecret(): string | null {
    const raw = this.config.get<string>('SASPAY_WEBHOOK_SECRET')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Vrai uniquement si les secrets minimaux sont configurés. */
  isConfigured(): boolean {
    return this.apiKey !== null && this.webhookSecret !== null;
  }
}
