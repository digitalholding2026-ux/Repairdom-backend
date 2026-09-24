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

  /** Vérifie la cohérence clé ↔ mode prestataire (SASPAY-03) :
   *  LIVE exige `sk_live_…`, TEST exige `sk_test_…`. Une clé live en TEST
   *  (ou l'inverse) déplacerait de l'argent réel en test — refus explicite.
   *  Retourne null si cohérent, sinon le motif de refus. */
  keyModeMismatch(): string | null {
    const key = this.apiKey;
    if (!key) return 'clé API SasPay absente';
    const live = key.startsWith('sk_live_');
    const test = key.startsWith('sk_test_');
    if (!live && !test) return 'clé API SasPay au format inattendu (sk_test_/sk_live_ attendu)';
    if (this.mode === 'LIVE' && !live) return 'mode LIVE avec une clé non-live : utilisez sk_live_…';
    if (this.mode === 'TEST' && !test) return 'mode TEST avec une clé non-test : utilisez sk_test_…';
    return null;
  }
}
