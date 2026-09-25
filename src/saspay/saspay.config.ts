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

  /* Relais payout VPS (sortie IP fixe) — optionnel, init payout uniquement.
   * Si `SASPAY_PAYOUT_RELAY_URL` est définie, `initializePayout()` POSTe au
   * relay (X-Relio-Relay-Secret, même Idempotency-Key, même body, SANS clé
   * SasPay) au lieu d'appeler SasPay directement. Verify/webhooks/top-up
   * restent directs. Valeurs lues, jamais journalisées. */
  /** URL publique du relay payout (ex. https://api.relioo.space/payout/initialize). */
  get payoutRelayUrl(): string | null {
    const raw = this.config.get<string>('SASPAY_PAYOUT_RELAY_URL')?.trim().replace(/\/+$/, '');
    return raw && raw.length > 0 ? raw : null;
  }

  /** Secret partagé Railway → relay (header X-Relio-Relay-Secret). */
  get payoutRelaySecret(): string | null {
    const raw = this.config.get<string>('SASPAY_PAYOUT_RELAY_SECRET')?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  /** Vrai uniquement si les secrets minimaux sont configurés. */
  isConfigured(): boolean {
    return this.apiKey !== null && this.webhookSecret !== null;
  }

  /** Vérifie la cohérence clé ↔ mode prestataire.
   *
   *  SasPay détermine l'environnement par la clé elle-même (pas d'endpoint
   *  TEST séparé) ; `SASPAY_MODE` reste un garde-fou interne Relio :
   *  - LIVE exige `sk_live_…` (comportement inchangé) ;
   *  - TEST n'exige plus `sk_test_…` mais n'autorise jamais d'appel réel
   *    avec une clé live : une clé `sk_live_…` en TEST est refusée (aucune
   *    tentative de paiement, aucune simulation de réel) — TEST reste le
   *    mode interne non-réel de Relio. Une clé `sk_test_…` en TEST reste
   *    acceptée.
   *  Retourne null si cohérent, sinon le motif de refus. */
  keyModeMismatch(): string | null {
    const key = this.apiKey;
    if (!key) return 'clé API SasPay absente';
    const live = key.startsWith('sk_live_');
    const test = key.startsWith('sk_test_');
    if (!live && !test) return 'clé API SasPay au format inattendu (sk_test_/sk_live_ attendu)';
    if (this.mode === 'LIVE' && !live) return 'mode LIVE avec une clé non-live : utilisez sk_live_…';
    if (this.mode === 'TEST' && live) {
      return 'mode TEST avec une clé live (sk_live_…) : appels réels désactivés — passez en LIVE pour le réel ou utilisez une clé de test.';
    }
    return null;
  }
}
